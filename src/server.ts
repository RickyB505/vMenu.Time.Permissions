/// <reference types="@citizenfx/server" />

const EXPECTED_RESOURCE_NAME = "vMenu.Time.Permissions";
const CONFIG_FILE_NAME = "config.json";
const KVP_FLUSH_INTERVAL_MS = 60_000; // 1 minute

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const INT32_MAX = 2_147_483_647;

interface PlayerData {
    lastUpdate: number;
    totalTime: number;
}

interface Tier {
    time: number;
    group: string;
    permissions: string[];
}

let timeValues: Record<string, string[]> = {};
const tiers: Tier[] = [];
const playerDatas = new Map<string, PlayerData>(); 
let kvpLastFlush = currentTime();
let serverMultiplier = 1.0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentTime(): number {
    return Date.now();
}

function parseJsonc<T>(text: string): T {
    let out = "";
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const n = text[i + 1];

        if (inString) {
            out += c;
            if (c === "\\") {
                out += n ?? "";
                i++;
            } else if (c === '"') {
                inString = false;
            }
            continue;
        }

        if (c === '"') {
            inString = true;
            out += c;
        } else if (c === "/" && n === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            out += "\n";
        } else if (c === "/" && n === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
            i++;
        } else {
            out += c;
        }
    }
    out = out.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(out) as T;
}

function* parseKey(key: string): Generator<{ amount: number; unit: string }> {
    for (const m of key.matchAll(/(\d+)([a-zA-Z]+)/g)) {
        yield { amount: parseInt(m[1], 10), unit: m[2] };
    }
}

function keyToMs(key: string): number {
    let total = 0;
    for (const { amount, unit } of parseKey(key)) {
        switch (unit.toLowerCase()) {
            case "second": total += amount * MS_PER_SECOND; break;
            case "minute": total += amount * MS_PER_MINUTE; break;
            case "hour": total += amount * MS_PER_HOUR; break;
            case "day": total += amount * MS_PER_DAY; break;
        }
    }
    return total;
}

function formatPlaytime(milliseconds: number): string {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(" ");
}

function getDiscordId(playerId: number): string | null {
    if (!getPlayers().includes(String(playerId))) return null;
    return GetPlayerIdentifierByType(String(playerId), "discord") || null;
}

function refreshPermissions(...serverIds: number[]): void {
    emit("vMenu.Enhanced:Permissions:Refresh", serverIds);
}

/** Resource KVP ints are 32-bit signed, so clamp instead of wrapping negative. */
function saveKvp(id: string, totalMs: number): void {
    SetResourceKvpInt(id, Math.max(0, Math.min(Math.floor(totalMs), INT32_MAX)));
}

function logError(tag: string, message: string): void {
    console.error(`[${tag}] ${message}`);
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

function setUpPermissionGroups(): void {
    for (const [key, permissions] of Object.entries(timeValues)) {
        tiers.push({ time: keyToMs(key), group: key, permissions });

        for (const permission of permissions) {
            ExecuteCommand(`add_ace group.${key} "${permission}" allow`);
        }

        ExecuteCommand(`add_ace group.${key} group.${key} allow`);
    }
}

function grantEarnedPermissions(
    totalTime: number,
    now: number,
    lastUpdate: number,
    playerId: number,
    discordId: string
): number {
    totalTime += Math.trunc((now - lastUpdate) * serverMultiplier);

    const earnedTiers = tiers
        .filter((t) => t.time <= totalTime)
        .sort((a, b) => b.time - a.time);

    let grantedAny = false;

    for (const tier of earnedTiers) {
        const groupName = `group.${tier.group}`;

        if (IsPlayerAceAllowed(String(playerId), groupName)) continue;

        ExecuteCommand(`add_principal identifier.${discordId} ${groupName}`);
        grantedAny = true;
    }

    if (grantedAny) {
        setImmediate(() => refreshPermissions(playerId));
    }

    return totalTime;
}

function updatePlayerTimes(): void {
    const now = currentTime();
    const activeIds = new Set<string>();

    for (const handle of getPlayers()) {
        if (GetPlayerPed(handle) === 0) continue;

        const discordId = GetPlayerIdentifierByType(handle, "discord");
        if (!discordId) continue;

        activeIds.add(discordId);

        const existing = playerDatas.get(discordId);
        if (!existing) {
            playerDatas.set(discordId, {
                lastUpdate: now,
                totalTime: GetResourceKvpInt(discordId),
            });
            continue;
        }

        const newTotal = grantEarnedPermissions(
            existing.totalTime,
            now,
            existing.lastUpdate,
            parseInt(handle, 10),
            discordId
        );

        playerDatas.set(discordId, { lastUpdate: now, totalTime: newTotal });
    }

    for (const [id, data] of playerDatas) {
        if (!activeIds.has(id)) {
            saveKvp(id, data.totalTime);
            playerDatas.delete(id);
        }
    }
}

function flushKvpIfDue(): void {
    if (currentTime() - kvpLastFlush < KVP_FLUSH_INTERVAL_MS) return;

    for (const [id, data] of playerDatas) {
        saveKvp(id, data.totalTime);
    }

    kvpLastFlush = currentTime();
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

function initialize(): void {
    const resourceName = GetCurrentResourceName();
    if (resourceName !== EXPECTED_RESOURCE_NAME) {
        const msg = `Resource name "${resourceName}" is invalid. Set it to "${EXPECTED_RESOURCE_NAME}" for the resource to start working.`;
        console.error(msg);
        throw new Error(msg);
    }

    const configJson = LoadResourceFile(resourceName, CONFIG_FILE_NAME);
    if (!configJson) return;

    try {
        const parsed = parseJsonc<Record<string, string[]>>(configJson);
        if (!parsed) throw new Error("Deserialized time values were null.");
        timeValues = parsed;
    } catch (e) {
        console.error(String(e));
        throw e;
    }

    setUpPermissionGroups();

    setInterval(() => {
        try {
            updatePlayerTimes();
            flushKvpIfDue();
        } catch (e) {
            console.error(`[CheckPlayerTime] ${String(e)}`);
        }
    }, 1000);
}

// ---------------------------------------------------------------------------
// Commands (restricted = true -> require ace permission "command.<name>")
// ---------------------------------------------------------------------------

RegisterCommand(
    "GetPlayerPlaytime",
    (_source: number, args: string[]) => {
        const tag = "GetPlayerPlaytime";
        const targetId = parseInt(args[0], 10);
        if (Number.isNaN(targetId)) return logError(tag, `'${args[0]}' is not a valid player id.`);

        const discordId = getDiscordId(targetId);
        if (!discordId) return logError(tag, `No discord identifier found for player ${targetId}.`);

        const data = playerDatas.get(discordId);
        if (!data) return logError(tag, `Player ${targetId} is not currently tracked.`);

        const liveTotal = data.totalTime + (currentTime() - data.lastUpdate);
        console.log(`Player ${targetId} playtime: ${formatPlaytime(liveTotal)}`);
    },
    true
);

RegisterCommand(
    "ResetPlayerPlayTime",
    (_source: number, args: string[]) => {
        const tag = "ResetPlayerPlayTime";
        const targetId = parseInt(args[0], 10);
        if (Number.isNaN(targetId)) return logError(tag, `'${args[0]}' is not a valid player id.`);

        const discordId = getDiscordId(targetId);
        if (!discordId) return logError(tag, `No discord identifier found for player ${targetId}.`);

        if (!playerDatas.has(discordId)) return logError(tag, `Player ${targetId} is not currently tracked.`);

        playerDatas.set(discordId, { lastUpdate: currentTime(), totalTime: 0 });
        SetResourceKvpInt(discordId, 0);

        let revokedAny = false;

        for (const tier of tiers) {
            const groupName = `group.${tier.group}`;
            if (!IsPlayerAceAllowed(String(targetId), groupName)) continue;

            ExecuteCommand(`remove_principal identifier.${discordId} ${groupName}`);
            revokedAny = true;
        }

        if (revokedAny) refreshPermissions(targetId);

        console.log(`[${tag}] Reset playtime and revoked permissions for player ${targetId}.`);
    },
    true
);

RegisterCommand(
    "SetPlayerPlayTime",
    (_source: number, args: string[]) => {
        const tag = "SetPlayerPlayTime";
        const targetId = parseInt(args[0], 10);
        if (Number.isNaN(targetId)) return logError(tag, `'${args[0]}' is not a valid player id.`);

        const secondsValue = Number(args[1]);
        if (args[1] === undefined || !Number.isInteger(secondsValue) || secondsValue < 0) {
            return logError(tag, `'${args[1]}' is not a valid number of seconds.`);
        }

        const discordId = getDiscordId(targetId);
        if (!discordId) return logError(tag, `No discord identifier found for player ${targetId}.`);

        const newTotalMs = secondsValue * MS_PER_SECOND;

        playerDatas.set(discordId, { lastUpdate: currentTime(), totalTime: newTotalMs });
        saveKvp(discordId, newTotalMs);

        let changedAny = false;

        for (const tier of tiers) {
            const groupName = `group.${tier.group}`;
            const hasAce = IsPlayerAceAllowed(String(targetId), groupName);
            const shouldHave = tier.time <= newTotalMs;

            if (shouldHave && !hasAce) {
                ExecuteCommand(`add_principal identifier.${discordId} ${groupName}`);
                changedAny = true;
            } else if (!shouldHave && hasAce) {
                ExecuteCommand(`remove_principal identifier.${discordId} ${groupName}`);
                changedAny = true;
            }
        }

        if (changedAny) refreshPermissions(targetId);

        console.log(`[${tag}] Set player ${targetId} playtime to ${formatPlaytime(newTotalMs)}.`);
    },
    true
);

RegisterCommand(
    "SetServerPlaytimeMulti",
    (_source: number, args: string[]) => {
        const tag = "SetServerPlaytimeMulti";
        const multi = Number(args[0]);
        if (args[0] === undefined || !Number.isFinite(multi)) {
            return logError(tag, `'${args[0]}' is not a valid multiplier.`);
        }

        console.log(`[${tag}] Server playtime multiplier is now ${multi} (was ${serverMultiplier})`);
        serverMultiplier = multi;
    },
    true
);

RegisterCommand(
    "GetServerPlaytimeMulti",
    () => {
        console.log(`[GetServerPlaytimeMulti] Current server playtime multiplier is ${serverMultiplier}`);
    },
    true
);

initialize();
