# vMenu.Time.Permissions

A FiveM server resource that automatically grants [vMenu.Enhanced](https://github.com/TomGrobbe/vMenu/tree/enhanced) permissions to players based on how long they've spent on your server. Instead of manually assigning ranks, players unlock more of vMenu's menu the longer they play — tracked per Discord identifier and persisted across restarts.

## How it works

1. `config.json` defines a set of time **tiers** — e.g. `"1hour"` — each mapped to a list of vMenu ace permissions.
2. On startup, the resource creates a `group.<tier>` ACE group for every tier and adds the listed permissions to it.
3. Every second, the resource checks each connected player's accumulated playtime (tracked by their `discord` identifier) and adds them as a principal of any tier group they've now earned.
4. Playtime is flushed to the resource's KVP store once a minute, so a player's progress survives server restarts.
5. Players keep every tier they've crossed, not just the highest one, and vMenu's permission cache is refreshed automatically whenever a new tier unlocks.

Players without a Discord identifier are ignored, since progress is keyed by Discord ID.

## Requirements

- A FiveM server running the **Enhanced** runtime (`gta5enhanced`)
- [vMenu.Enhanced](https://github.com/TomGrobbe/vMenu/tree/enhanced) (or another resource exposing the same `vMenu.Enhanced.*` ace permissions and the `vMenu.Enhanced:Permissions:Refresh` event) installed and running
- .NET 10 SDK, only if you're building the resource yourself

## Installation

1. Build (see below) or download a compiled release of the resource.
2. Place the output folder in your server's `resources` directory. The resource's internal name **must** be `vMenu.Time.Permissions` — the resource checks its own name at startup and refuses to start otherwise.
3. Edit `config.json` (see below) to define your time tiers and permissions.
4. Add to your `server.cfg`, after vMenu.Enhanced:

   ```cfg
   add_ace resource.vMenu.Time.Permissions command.add_ace allow
   add_ace resource.vMenu.Time.Permissions command.add_principal allow
   add_ace resource.vMenu.Time.Permissions command.remove_principal allow
   
   ensure vMenu.Enhanced
   ensure vMenu.Time.Permissions
   ```

## Building from source

```bash
dotnet build vMenu.Time.Permissions.slnx -c Release
```

The project outputs to `../Resource/vMenu.Time.Permissions/server`, alongside `config.json` and `fxmanifest.lua`, so the built output folder is ready to drop straight into your `resources` directory.

## Configuration (`config.json`)

```jsonc
{
  "1minute": [
    "vMenu.Enhanced.Menus.PlayerOptions.Menu"
    // ...
  ],
  "5minute": [
    "vMenu.Enhanced.Menus.VehicleSpawner.Menu"
    // ...
  ],
  "1hour": [
    "vMenu.Enhanced.Menus.WeaponOptions.Modify"
  ],
  "1minute1day": [
    // keys can combine units, e.g. 1 day + 1 minute of playtime
  ]
}
```

- Each key is a **duration**: one or more `<number><unit>` pairs concatenated together (e.g. `"1minute1day"` = 1 minute + 1 day).
- Supported units: `second`, `minute`, `hour`, `day` (case-insensitive). Unrecognized units are silently treated as zero.
- Each key becomes an ACE group (`group.<key>`) containing every permission string in its array.
- An empty array (`[]`) is valid — it creates the tier/group with no permissions attached.
- The shipped `config.json` is tuned around vMenu.Enhanced's own ace permission names, from a `1minute` starter tier up through `3day` for military vehicles and higher spawn limits — edit it freely to match your server's permission set and pacing.

## Commands

All commands are server-restricted (add ace permissions for them like any other restricted command).

| Command | Usage | Description |
|---|---|---|
| `GetPlayerPlaytime` | `GetPlayerPlaytime <playerId>` | Logs a player's current tracked playtime. |
| `ResetPlayerPlayTime` | `ResetPlayerPlayTime <playerId>` | Resets a player's playtime to 0 and revokes every tier group they hold. |
| `SetPlayerPlayTime` | `SetPlayerPlayTime <playerId> <seconds>` | Sets a player's playtime directly and syncs their tier groups to match. |
| `SetServerPlaytimeMulti` | `SetServerPlaytimeMulti <multiplier>` | Sets a global multiplier applied to playtime accrual (e.g. `2` = players earn playtime twice as fast). Default `1`. |
| `GetServerPlaytimeMulti` | `GetServerPlaytimeMulti` | Logs the current playtime multiplier. |

## Notes & caveats

- Playtime tracking and tier grants are entirely server-side and driven by wall-clock time while a player with a Discord identifier is connected.
- The playtime multiplier set via `SetServerPlaytimeMulti` is in-memory only and resets to `1` on restart.
- This resource only *grants* permissions; it doesn't create or manage the underlying vMenu permission list — the permission strings in `config.json` must match ones vMenu.Enhanced actually checks.

## License

[AGPL-3.0](LICENSE.txt)
