using System.Text.Json;
using System.Text.RegularExpressions;
using System.Collections.Concurrent;
using CitizenFX.FiveM.Server;
using CitizenFX.FiveM.Shared.Script;
using CitizenFX.FiveM.Shared.Serialization;

namespace vMenu.Time.Permissions.Server;

public class Main : IScript
{
    private const string ExpectedResourceName = "vMenu.Time.Permissions";
    private const string ConfigFileName = "config.json";
    private const long KvpFlushIntervalMs = 60_000; // 1 minute

    public required IDictionary<string, IList<string>> TimeValues;

    private readonly ConcurrentDictionary<(int Time, string Group), IList<string>> _calculatedTimes = [];
    private static readonly ConcurrentDictionary<string, PlayerData> PlayerDatas = new();
    private static long _kvpLastFlush = CurrentTime();
    private static readonly JsonSerializerOptions ConfigJsonOptions = new()
    {
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true
    };
    public async void Initialize()
    {
        var resourceName = Native.GetCurrentResourceName();
        if (resourceName != ExpectedResourceName)
        {
            API.Log.Error($"Resource name \"{resourceName}\" is invalid. Set it to \"{ExpectedResourceName}\" for the resource to start working.");
            throw new Exception($"Resource name \"{resourceName}\" is invalid. Set it to \"{ExpectedResourceName}\" for the resource to start working.");
        }

        var configJson = Native.LoadResourceFile(resourceName, ConfigFileName);
        if (string.IsNullOrEmpty(configJson)) return;

        try
        {
            TimeValues = JsonSerializer.Deserialize<IDictionary<string, IList<string>>>(configJson, ConfigJsonOptions)
                ?? throw new InvalidOperationException("Deserialized time values were null.");
        }
        catch (Exception e)
        {
            API.Log.Error(e.ToString());
            throw;
        }
        
        SetUpPermissionGroups();

        _ = CheckPlayerTime();
    }

    private void SetUpPermissionGroups()
    {
        foreach (var (key, permissions) in TimeValues)
        {
            long totalTimeMs = ParseKey(key).Sum(part => part.Unit.ToLower() switch
            {
                "second" => part.Amount * TimeSpan.MillisecondsPerSecond,
                "minute" => part.Amount * TimeSpan.MillisecondsPerMinute,
                "hour" => part.Amount * TimeSpan.MillisecondsPerHour,
                "day" => part.Amount * TimeSpan.MillisecondsPerDay,
                _ => 0
            });

            _calculatedTimes[((int)totalTimeMs, key)] = permissions;

            foreach (var permission in permissions)
            {
                Native.ExecuteCommand($"add_ace group.{key} \"{permission}\" allow");
            }

            Native.ExecuteCommand($"add_ace group.{key} group.{key} allow");
        }
    }

    private async Task CheckPlayerTime()
    {
        while (true)
        {
            UpdatePlayerTimes(); 
            FlushKvpIfDue();
            await API.Delay(1000);
        }
    }

    private void UpdatePlayerTimes()
    {
        var currentTime = CurrentTime();
        var activeIds = new HashSet<string>();

        foreach (var player in API.Players.All)
        {
            if (player.Ped is null) continue;

            var discordId = Native.GetPlayerIdentifierByType(player.StrHandle, "discord");
            if (string.IsNullOrEmpty(discordId)) continue;

            activeIds.Add(discordId);

            if (!PlayerDatas.TryGetValue(discordId, out var existing))
            {
                PlayerDatas[discordId] = new PlayerData(currentTime, Native.GetResourceKvpInt(discordId));
                continue;
            }

            int newTotal = (int)GrantEarnedPermissions(
                existing.TotalTime,
                currentTime,
                existing.LastUpdate,
                player.Handle,
                discordId);

            PlayerDatas[discordId] = new PlayerData(currentTime, newTotal);
        }

        foreach (var id in PlayerDatas.Keys)
        {
            if (!activeIds.Contains(id))
            {
                PlayerDatas.TryRemove(id, out _);
            }
        }
    }

    private void FlushKvpIfDue()
    {
        if (CurrentTime() - _kvpLastFlush < KvpFlushIntervalMs) return;

        foreach (var (id, data) in PlayerDatas)
        {
            Native.SetResourceKvpInt(id, data.TotalTime);
        }

        _kvpLastFlush = CurrentTime(); 
    }
    
    private long GrantEarnedPermissions(long totalTime, long currentTime, long lastUpdate, int playerId, string discordId)
    {
        totalTime += (int)((currentTime - lastUpdate) * _serverMultiplier);

        var earnedTiers = _calculatedTimes
            .Where(tier => tier.Key.Time <= totalTime)
            .OrderByDescending(tier => tier.Key.Time);

        bool grantedAny = false;

        foreach (var tier in earnedTiers)
        {
            var groupName = $"group.{tier.Key.Group}";

            if (Native.IsPlayerAceAllowed(playerId.ToString(), groupName)) continue;

            Native.ExecuteCommand($"add_principal identifier.{discordId} {groupName}");
            grantedAny = true;
        }

        if (grantedAny)
        {
            API.NextTick(() => RefreshPermissions(playerId));
        }
        return totalTime;
    }
    
    private static IEnumerable<(int Amount, string Unit)> ParseKey(string key)
    {
        foreach (Match m in Regex.Matches(key, @"(\d+)([a-zA-Z]+)"))
        {
            yield return (int.Parse(m.Groups[1].Value), m.Groups[2].Value);
        }
    }
    [OnCommand("GetPlayerPlaytime", Restricted = true)]
    public void GetPlayerPlaytimeCommand([FromSource] int source, string playerId)
    {
        if (!int.TryParse(playerId, out var targetId))
        {
            API.Log.Error($"[GetPlayerPlaytime] '{playerId}' is not a valid player id.");
            return;
        }

        var discordId = GetDiscordId(targetId);
        if (discordId is null)
        {
            API.Log.Error($"[GetPlayerPlaytime] No discord identifier found for player {targetId}.");
            return;
        }

        if (!PlayerDatas.TryGetValue(discordId, out var data))
        {
            API.Log.Error($"[GetPlayerPlaytime] Player {targetId} is not currently tracked.");
            return;
        }

        long liveTotal = data.TotalTime + (CurrentTime() - data.LastUpdate);
        API.Log.Info($"Player {targetId} playtime: {FormatPlaytime(liveTotal)}");
    }
    
    [OnCommand("ResetPlayerPlayTime", Restricted = true)]
    public void ResetPlayerPlayTime([FromSource] int source, string playerId)
    {
        if (!int.TryParse(playerId, out var targetId))
        {
            API.Log.Error($"[ResetPlayerPlayTime] '{playerId}' is not a valid player id.");
            return;
        }

        var discordId = GetDiscordId(targetId);
        if (discordId is null)
        {
            API.Log.Error($"[ResetPlayerPlayTime] No discord identifier found for player {targetId}.");
            return;
        }

        if (!PlayerDatas.TryGetValue(discordId, out var _))
        {
            API.Log.Error($"[ResetPlayerPlayTime] Player {targetId} is not currently tracked.");
            return;
        }

        PlayerDatas[discordId] = new PlayerData(CurrentTime());
        Native.SetResourceKvpInt(discordId, 0);

        bool revokedAny = false;

        foreach (var tier in _calculatedTimes)
        {
            var groupName = $"group.{tier.Key.Group}";

            if (!Native.IsPlayerAceAllowed(targetId.ToString(), groupName)) continue;

            Native.ExecuteCommand($"remove_principal identifier.{discordId} {groupName}");
            revokedAny = true;
        }

        if (revokedAny)
        {
            RefreshPermissions(targetId);
        }

        API.Log.Info($"[ResetPlayerPlayTime] Reset playtime and revoked permissions for player {targetId}.");
    }
    
    [OnCommand("SetPlayerPlayTime", Restricted = true)]
    public void SetPlayerPlayTime([FromSource] int source, string playerId, string seconds)
    {
        if (!int.TryParse(playerId, out var targetId))
        {
            API.Log.Error($"[SetPlayerPlayTime] '{playerId}' is not a valid player id.");
            return;
        }

        if (!long.TryParse(seconds, out var secondsValue) || secondsValue < 0)
        {
            API.Log.Error($"[SetPlayerPlayTime] '{seconds}' is not a valid number of seconds.");
            return;
        }

        var discordId = GetDiscordId(targetId);
        if (discordId is null)
        {
            API.Log.Error($"[SetPlayerPlayTime] No discord identifier found for player {targetId}.");
            return;
        }

        long newTotalMs = secondsValue * TimeSpan.MillisecondsPerSecond;

        PlayerDatas[discordId] = new PlayerData(CurrentTime(), (int)newTotalMs);
        Native.SetResourceKvpInt(discordId, (int)newTotalMs);

        bool changedAny = false;

        foreach (var tier in _calculatedTimes)
        {
            var groupName = $"group.{tier.Key.Group}";
            bool hasAce = Native.IsPlayerAceAllowed(targetId.ToString(), groupName);
            bool shouldHave = tier.Key.Time <= newTotalMs;

            if (shouldHave && !hasAce)
            {
                Native.ExecuteCommand($"add_principal identifier.{discordId} {groupName}");
                changedAny = true;
            }
            else if (!shouldHave && hasAce)
            {
                Native.ExecuteCommand($"remove_principal identifier.{discordId} {groupName}");
                changedAny = true;
            }
        }

        if (changedAny)
        {
            RefreshPermissions(targetId);
        }

        API.Log.Info($"[SetPlayerPlayTime] Set player {targetId} playtime to {FormatPlaytime(newTotalMs)}.");
    }

    private static float _serverMultiplier = 1.0f;
    [OnCommand("SetServerPlaytimeMulti", Restricted = true)]
    public void SetPlayerPlayTimeAsync([FromSource] int source, string multiplier)
    {
        if (!float.TryParse(multiplier, out var multi))
        {
            API.Log.Error($"[SetServerPlaytimeMulti] '{multiplier}' is not a valid multiplier.");
            return;
        }
        
        API.Log.Info($"[GetServerPlaytimeMulti] Current server playtime multiplier is {multi} used to be {_serverMultiplier}");
        _serverMultiplier = multi;
    }
    [OnCommand("GetServerPlaytimeMulti", Restricted = true)]
    public void SetPlayerPlayTimeAsync([FromSource] int source)
    {
        API.Log.Info($"[GetServerPlaytimeMulti] Current server playtime multiplier is {_serverMultiplier}");
    }
    
    private static string FormatPlaytime(long milliseconds)
    {
        var ts = TimeSpan.FromMilliseconds(milliseconds);
        var parts = new List<string>();

        if (ts.Days > 0) parts.Add($"{ts.Days}d");
        if (ts.Hours > 0) parts.Add($"{ts.Hours}h");
        if (ts.Minutes > 0) parts.Add($"{ts.Minutes}m");
        if (ts.Seconds > 0 || parts.Count == 0) parts.Add($"{ts.Seconds}s");

        return string.Join(" ", parts);
    }
    private static string? GetDiscordId(int playerId)
    {
        var player = API.Players.All.FirstOrDefault(p => p.Handle == playerId);
        return player is null ? null : Native.GetPlayerIdentifierByType(player.StrHandle, "discord");
    }
    private static void RefreshPermissions(params int[] serverIds) =>
        NativeFixer.EmitLocal("vMenu.Enhanced:Permissions:Refresh", (object)serverIds);

    private static long CurrentTime() => DateTimeOffset.Now.ToUnixTimeMilliseconds();

    private record PlayerData(long LastUpdate, int TotalTime = 0);
}