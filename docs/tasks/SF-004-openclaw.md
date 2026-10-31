
SF-004 — Локално стартиране и ограничаване на OpenClaw

Прочети приложимите repository инструкции и инсталирания Matt Pocock `/implement` skill.

Работиш по инфраструктурното repository `/home/teo/IdeaProjects/software-factory`. То е медиатор между ChatGPT и OpenClaw. Бъдещият Claude Code ще работи в друго repository и няма да получава достъп до медиатора.

**Цел на тази итерация:** да имаме реално инсталиран, стартиран и проверен локален OpenClaw Gateway.

1. Провери текущите OS, Node.js, OpenClaw и systemd настройки. Използвай актуалната официална документация на https://docs.openclaw.ai.
2. Инсталирай OpenClaw по официален начин, без ненужно презаписване на съществуващи конфигурации.
3. Предпочитай отделен Linux потребител и изолирана конфигурация за OpenClaw. Ако са нужни sudo, създаване на OS потребител или промяна на системни права, подготви точните ръчни стъпки и поискай изпълнението им от потребителя. Не ескалирай привилегии автоматично.
4. Конфигурирай Gateway само на loopback, със собствена автентикация. Без публичен порт, LAN достъп, Tailscale Funnel или външни chat канали.
5. Не давай достъп до application repository, home директорията на Claude, неговите credentials или Git инструменти. Не активирай host exec, elevated tools, browser automation или непроверени външни skills.
6. Не конфигурирай платен model API и не копирай Claude Code login/credentials в OpenClaw. Провери дали Gateway може да се стартира и диагностицира без модел. Ако има ограничение, отчети го точно.
7. Провери реално:
    - версията;
    - Gateway startup/status;
    - здравето на процеса;
    - loopback listener;
    - `openclaw doctor`;
    - `openclaw security audit` и, ако е приложимо, `--deep`;
    - нормално спиране и рестарт.
8. Документирай команди за start/stop/restart и начина, по който Gateway ще работи след нов login или reboot. Не настройвай автоматично стартиране без изрично одобрение, ако изисква системна промяна.

**Не интегрирай още OpenClaw с Claude Code. Не добавяй MCP инструменти за dispatch или файлов запис. Не изграждай собствен оркестратор.**

Не спирай и не променяй съществуващите Software Factory bridge и tunnel-client процеси.

Създай `docs/tasks/SF-004-openclaw-bootstrap.md`, `docs/reports/SF-004-report.md` и необходим review пакет. Запиши реално достигнатия етап, проверките, ограниченията и оставащите ръчни стъпки.

Без staging, unstaging, commit или push.