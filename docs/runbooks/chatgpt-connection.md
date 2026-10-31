# Runbook: ChatGPT ↔ локален bridge през Secure MCP Tunnel

Проверено с tunnel-client **v0.0.18** (`0.0.18+274a5588`) на Linux x86_64, Node v24.17.0. Реалната ChatGPT проба мина на 2026-10-25 (вижте `docs/reports/SF-002-report.md`).

Задача: `docs/tasks/SF-002-connect-chatgpt.md`. Отчет: `docs/reports/SF-002-report.md`.

Тук няма тайни. Runtime ключът стои само във файл с права 0600 извън repository-то.

## Как минава заявката

```
ChatGPT (Work чат, plugin "Software Factory", No authentication)
  → OpenAI-hosted /v1/mcp/{tunnel_id}
  ← tunnel-client на тази машина: изходящ HTTPS към api.openai.com:443, long-poll
  → http://127.0.0.1:8787/mcp   (bridge, само loopback)
  → factory-data/probe.txt
```

Няма входящ порт, port forwarding или публичен listener.

Credential-ите са на два слоя:
- **Транспорт.** Runtime ключът се ползва само от tunnel-client (`file:` референция в профила).
- **MCP.** Слоят е без OAuth: в ChatGPT е избрано *No authentication*. Това е допустимо само за трите probe tools зад частния тунел.

## Файлове и места

| Какво | Къде |
| --- | --- |
| tunnel-client | `~/.local/opt/tunnel-client/v0.0.18/` (+ bundled `cloudflared`), symlink `~/.local/bin/tunnel-client` |
| Профил | `~/.config/tunnel-client/software-factory.yaml` (създава се с `scripts/sf-tunnel.sh init`) |
| Пример за профила | `config/tunnel-client/software-factory.example.yaml` |
| Runtime ключ | `~/.config/software-factory/tunnel-runtime.key` (0600, директория 0700) |
| Launcher | `scripts/sf-tunnel.sh` (`init`, `set-key`, `check`, `doctor`, `run`) |
| Bridge | `bridge/` на `127.0.0.1:8787/mcp`, данни в `factory-data/probe.txt` |
| tunnel-client admin | `http://127.0.0.1:8790/ui`, `/healthz`, `/readyz` (само loopback) |

## Инсталация на tunnel-client (направено веднъж)

Източник: https://github.com/openai/tunnel-client/releases/latest (v0.0.18, flavor `client`).

```bash
d=$(mktemp -d) && cd "$d"
base=https://github.com/openai/tunnel-client/releases/download/v0.0.18
curl -fsSLO "$base/tunnel-client-v0.0.18-linux-amd64.zip"
curl -fsSLO "$base/SHA256SUMS.txt"
sha256sum -c --ignore-missing SHA256SUMS.txt     # expect: ...linux-amd64.zip: OK
mkdir -p ~/.local/opt/tunnel-client/v0.0.18 ~/.local/bin
unzip -oq tunnel-client-v0.0.18-linux-amd64.zip -d ~/.local/opt/tunnel-client/v0.0.18
ln -sfn ~/.local/opt/tunnel-client/v0.0.18/tunnel-client ~/.local/bin/tunnel-client
tunnel-client --version
```

Очакван SHA256 на zip-а: `3c82307316acd93c88a384b62af1d81d3f4cb0efa975f9c0bfaef922866a04c4`. Стойността съвпада със `SHA256SUMS.txt` и с digest-а в GitHub API. Sigstore attestation не е проверена, защото `gh` липсва на машината.

## Акаунт стъпки (прави ги потребителят)

Не поставяй ключ, парола или cookie в чата.

1. **Organization.** Отвори https://platform.openai.com и в горния ляв ъгъл избери personal Platform организацията, която ще притежава тунела.
2. **Права.** В https://platform.openai.com/settings/organization/people/roles провери, че имаш Tunnels **Read + Manage + Use**. Manage е нужно за създаване, а Use за runtime ключа и за избора на тунел в ChatGPT. Нова роля може да се разпространи до 30 минути.
3. **Тунел.** В https://platform.openai.com/settings/organization/tunnels създай тунел (име например `software-factory`).
   - В associations трябва да са и тази Platform организация, и целевият ChatGPT workspace.
   - Копирай `tunnel_id` (`tunnel_…`). Той е идентификатор, не тайна.
   - Ако опцията липсва, запиши точния текст на екрана, без лични данни.
4. **Runtime ключ.** В https://platform.openai.com/settings/organization/api-keys създай ключ за тунела. Принципалът му трябва да има Tunnels Read + Use.
   - Веднага го запиши локално в IntelliJ терминала:

     ```bash
     cd /home/teo/IdeaProjects/software-factory
     scripts/sf-tunnel.sh set-key      # hidden prompt; paste the key, Enter
     ```

   - Това е транспортен credential, не разрешение за model API usage.
   - Внимание: `set-key` иска runtime ключа (`sk-…`), не `tunnel_id`. При първия опит в SF-002 там беше въведен `tunnel_id` и control plane върна 401 Unauthorized. Сега `set-key` и `check` отхвърлят стойност, която започва с `tunnel_`.

## Локално пускане

Две отделни терминални сесии, по една за всеки процес.

**Bridge (терминал 1):**

```bash
cd /home/teo/IdeaProjects/software-factory/bridge
npm run build && npm start        # ready: "software-factory-bridge listening on http://127.0.0.1:8787/mcp"
```

**Тунел (терминал 2):**

```bash
cd /home/teo/IdeaProjects/software-factory
scripts/sf-tunnel.sh init tunnel_XXXXXXXX   # once, or when the tunnel changes
scripts/sf-tunnel.sh check                  # exit 0 = client, profile, key file, bridge OK
scripts/sf-tunnel.sh doctor                 # tunnel-client doctor --explain
scripts/sf-tunnel.sh run                    # foreground daemon; keep it running
tunnel-client health --port 8790 --require-control-plane-poll   # from another shell
```

Спиране:
- `Ctrl+C` в съответния терминал. `run` предава сигнала директно на tunnel-client чрез `exec`.
- Ако процесът е фонов: `kill -TERM <pid>`. Намираш PID с `pgrep -f 'tunnel-client run --profile software-factory'` и `ss -ltnp | grep 8787`.
- Спирай само тези два процеса.

Рестарт: спри процеса и пусни отново същата команда. Тунелът не поддържа два активни клиента едновременно, затова първо спри стария.

## Свързване в ChatGPT (докато `run` е здрав)

1. Отвори https://chatgpt.com/plugins, натисни **+** и избери **Add custom MCP server**.
2. Name: `Software Factory`. Description (по избор): `Local probe bridge (SF-002 pilot)`.
3. Connection: **Tunnel**. Избери тунела или въведи `tunnel_id`.
4. Authentication: **No authentication**. Runtime ключът **не** се въвежда тук.
5. Прочети предупреждението и избери **I understand and want to continue**, после **Create as a plugin**.
6. В детайлите на plugin-а провери, че са открити точно `factory_status`, `factory_write_probe` и `factory_read_probe`. След това натисни **Install**.
7. Отвори нов Work чат, напиши `@`, избери **Software Factory** и следвай пробата от задачата (§8).
   - `factory_write_probe` е write действие и ChatGPT ще поиска потвърждение.

При промяна на tool metadata използвай **Refresh** в настройките на plugin-а.

## Refresh след нов или променен tool (напр. SF-003 `factory_read_file`)

1. Рестартирай bridge-а с новия build. Спри стария процес (Ctrl+C или `kill -TERM <pid>` за процеса на `127.0.0.1:8787`), после пусни `cd bridge && npm run build && npm start`. Tunnel-client не е нужно да се рестартира; провери го с `tunnel-client health --port 8790 --require-control-plane-poll`.
2. В ChatGPT отвори https://chatgpt.com/plugins и избери съществуващия **Software Factory**. Не създавай нов plugin.
3. Натисни **Refresh**. Провери, че в списъка с tools са `factory_status`, `factory_write_probe`, `factory_read_probe` и `factory_read_file`.
4. Отвори **нов** Work чат и избери `@Software Factory`. Стар разговор не се обновява автоматично; ползвай го само ако вече вижда новия tool.

## Диагностика

- `scripts/sf-tunnel.sh check` показва коя локална предпоставка липсва.
- `tunnel-client doctor --profile software-factory --explain` проверява профила и връзката с control plane.
- `http://127.0.0.1:8790/ui` е admin UI-ят на tunnel-client.
- **`poll failed … 401 Unauthorized` в лога на `run`.** Ключовият файл не съдържа валиден runtime ключ за тази организация, или принципалът му няма Tunnels Read + Use.
- **Тунелът не се вижда в ChatGPT.** Провери associations към workspace-а и правото Use.
- **403 от bridge-а.** Наблюдавай само Host/Origin; виж задачата, §6.
