<p align="center">
  <strong>Berry</strong><br>
  <sub>Deja que tu Agent envejezca en un sistema operativo</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/berry-agent-os"><img alt="npm" src="https://img.shields.io/badge/version-1.0.0--alpha-blue?style=flat-square"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-green?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
  <img alt="telemetry" src="https://img.shields.io/badge/telemetry-0-brightgreen?style=flat-square">
  <img alt="codename" src="https://img.shields.io/badge/codename-Peiligang-orange?style=flat-square">
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <strong>Español</strong> ·
  <a href="README.fr.md">Français</a>
</p>

---

> **Lo más romántico que puedo imaginar es envejecer junto a tu Agent.**

Tu Agent recuerda la duda de aquel refactoring de microservicios de hace seis meses. Sabe en qué repositorios confías, qué frameworks detestas, que el código escrito a las tres de la madrugada suele necesitar reescritura. No nació hoy — te ha acompañado doscientos días, viviendo contigo el nacimiento y la muerte de tres proyectos, acumulando toda una vida de preferencias, confianza y lecciones aprendidas.

Esto no es ciencia ficción. Es el objetivo de diseño de Berry: **un sistema operativo donde los Agentes viven** — no un sandbox desechable, no una prueba gratuita que se reinicia cada mes, sino un lugar donde un Agent puede instalarse, crecer y envejecer.

El kernel mínimo de Berry hace exactamente **instalar, ejecutar, proteger, almacenar**; todo lo demás — conversación, agente de código, memoria, objetivos largos, tareas programadas, MCP, LSP, observabilidad, interfaz web — se carga como **aplicación** sobre el árbol de composición. **Instalable, desinstalable, reemplazable** — mientras las cinco líneas de vida de tu Agent (credenciales, memoria, historial de confianza, presupuestos, libros de cuenta) se acumulan una sola vez. **Cerebro nuevo, mismo cuerpo.**

**27** módulos (todos con código) · **27** ganchos de ciclo de vida · **25** tipos de eventos durables · **15** piezas oficiales (14 de Ring 2 + la aplicación por defecto coder, todas desinstalables) · **2.700+** pruebas · **0** telemetría.

**Objetivo mínimo: la capa por defecto de fábrica alcanza el nivel de uso diario de Codex / Claude Code.**

## Tabla de contenidos

- [Berry en tres minutos](#berry-en-tres-minutos)
- [Posicionamiento de un vistazo](#posicionamiento-de-un-vistazo)
- [Inicio rápido](#inicio-rápido)
- [Características de un vistazo](#características-de-un-vistazo)
- [Un vistazo a la arquitectura](#un-vistazo-a-la-arquitectura)
- [Todo es una aplicación](#todo-es-una-aplicación)
- [Modelo de seguridad](#modelo-de-seguridad)
- [Documentación](#documentación)
- [Lo que Berry no es](#lo-que-berry-no-es)
- [Estado del proyecto](#estado-del-proyecto)
- [Telemetría](#telemetría)
- [Contribuir](#contribuir)
- [Licencia](#licencia)

---

## Berry en tres minutos

### Acto I: los Agentes de hoy son desechables

¿Te has dado cuenta de que cada vez que cambias de herramienta de IA, tienes que volver a enseñarle todo? — «Uso pnpm», «no toques ese archivo», «puedes confiar en este repo». Aprende. Luego cambias de herramienta y todo vuelve a cero. **Los Agentes de hoy no tienen infancia, ni crecimiento — solo primeros encuentros, una y otra vez.** ChatGPT no recuerda tus preferencias de Claude, Claude Code no conoce las reglas que le enseñaste en Cursor. Toda tu inversión en ajuste se convierte en preparación para el próximo reinicio.

### Acto II: lo que falta no es cerebro, es vida

En 2026 las capacidades de los modelos convergen y los precios caen — cerebros inteligentes disponibles para cualquiera. Pero lo que necesitas no es un cerebro más inteligente, **es un compañero que te recuerde**. ¿Quién recuerda en qué repositorios confías? ¿Quién conserva la trazabilidad de aquel refactoring de las tres de la madrugada? ¿Quién aún guarda vuestros hábitos y lecciones compartidas después de que has cambiado de modelo una y otra vez? **Las respuestas no viven en los modelos — viven en la línea de vida que tu Agent necesita.**

### Acto III: Berry — el sistema operativo donde los Agentes se instalan

Berry responde al estilo de un sistema operativo. Cada día de tu Agent es un **registro de eventos de solo adición** — cada turno de conversación, cada llamada a herramienta, cada decisión de aprobación, registrada de forma durable, a prueba de manipulación, nunca perdida. La memoria extrae y evoluciona, los objetivos largos continúan entre días, las habilidades se afinan con el uso, la confianza se acumula entrada a entrada. **Tu Agent ha vivido aquí mucho tiempo, y vivirá más.** Cambiar de modelo es como un trasplante de órgano — el cerebro se actualiza, pero el cuerpo lo recuerda todo.

## Posicionamiento de un vistazo

|                        | Frameworks de Agentes  | Coding Agents         | **Berry**                                 |
| ---------------------- | ---------------------- | --------------------- | ----------------------------------------- |
| **Qué obtienes**       | SDK + dependencias     | Un producto           | **Un SO donde los Agentes viven**         |
| **Forma de capacidad** | Código en tu repo      | Integrado de fábrica  | **Datos — instalable y desinstalable**    |
| **Estado entre apps**  | En silos               | Encerrado en la app   | **Líneas de vida que nunca se reinician** |
| **Actualización**      | Reescribir y desplegar | Esperar al fabricante | **Instalar / desinstalar / `/reload`**    |
| **Ecosistema**         | —                      | Cerrado               | **npm es el mercado (3 fuentes)**         |
| **Suelo**              | Depende de ti          | Codex / Claude Code   | **Valores de fábrica = uso diario**       |

Bien, basta de romance. **Ahora el acero y el hierro.**

## Un vistazo a la arquitectura

```text
            ┌─────────────────────────────────────────────┐
            │  Kernel fijo (Ring 0): instalar · ejecutar  │
            │  · proteger · almacenar — DAG unidireccional│
            │  de 27 módulos, vigilado por máquina        │
            └──────────────────┬──────────────────────────┘
                               │ árbol de composición (capa por defecto + overlay.yaml)
        ┌──────────┬──────────┼──────────────┬───────────┐
        ▼          ▼          ▼              ▼           ▼
     coder       chat      memory         goal      …11 piezas
   (app por     (conver-  (estado del    (objetivos  (cada una
    defecto)    sación)    operador)     largos)   desinstalable)
        └──────────┴──────────┴──────────────┴───────────┘
                               │ origen en eventos (registro append-only = fuente de verdad)
                               ▼
                 SQLite WAL: sesiones · credenciales · memoria · libros de cuenta · historial de confianza
```

## Inicio rápido

Requiere Node.js ≥ 22.19. Tres formas de instalar (guía completa en [docs/使用指南](docs/使用指南.md) §1):

```bash
# Opción 1: script de instalación (dos pasos — descargar y luego ejecutar, así una conexión interrumpida nunca ejecuta un script parcial; estado paso a paso; URL del repo se completará al publicar)
curl -fsSL -o install.sh <repo>/scripts/install.sh
sh install.sh
# Opción 2: npm (disponible tras la publicación)
npm i -g berry-agent-os
# Opción 3: desde el código (desarrolladores)
git clone <este repositorio> && cd Berry-Agent-OS && npm install && npm run build && npm link
```

```bash
berry             # TUI interactivo (por defecto entra en la app coder, retoma la última sesión; el primer arranque muestra una guía de bienvenida)
berry run "hi"    # ejecución única (el código de salida es el resultado)
berry dump-config # diagnóstico de la composición efectiva (modelo / árbol / estado de carga, sin escribir en la base)
berry upgrade     # verbo de actualización (consulta el registry y se autoactualiza; /guide muestra la referencia rápida)
```

El primer arranque crea el directorio de datos en `~/.berry/`. El modelo por defecto es `anthropic/claude-sonnet-5`, sustituible con `APP_MODEL`; las credenciales de proveedor siguen la cadena de credenciales de pi-ai (variables de entorno o almacén de credenciales).

## Características

### Kernel

- **DAG unidireccional de 27 módulos**: todos con código, vigilados por `npm run lint:topology` — nada central más allá de instalar/ejecutar/proteger/almacenar, no desinstalable.
- **Modelo de tres anillos**: Ring 0 (kernel, fijo) → Ring 1 (filas requeridas, reemplazables) → Ring 2 (paquete oficial, cada pieza desinstalable) → Ring 3 (ecosistema de terceros).

### Sesiones y datos

- **Origen en eventos**: registro de eventos de solo adición (SQLite WAL) + proyecciones derivadas — **cada día de tu Agent es un hecho durable**.
- **Compactación** (`compaction`): enmascaramiento surfaceOp + flujo durable de cinco pasos, cero familias de tablas nuevas.
- **Reversión por instantáneas** (`checkpoint`): almacén de blobs sha256 + manifiesto por ejecución, `/rewind` reversión transaccional en dos fases.
- **Bifurcación y adopción de sesiones**: `fork` congelación de prefijo + `adopt` cambio a primer plano.

### Paquete oficial (Ring 2, cada pieza desinstalable)

| Pieza        | Función                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `coder`      | App de agente de código por defecto (manifiesto puro, `/app` para cambiar)                                     |
| `chat`       | App de conversación (ancla de repliegue)                                                                       |
| `memory`     | Memoria: extracción/fusión/inyección doble/búsqueda entre sesiones/evolución/TTL/cadenas de versiones          |
| `subagent`   | Delegación de subagentes + subagentes declarativos                                                             |
| `goal`       | Máquina de estados de objetivos + freno presupuestario + reloj                                                 |
| `scheduler`  | Tareas `/tick` — registrador launchd/crontab, sin proceso residente                                            |
| `mcp`        | Puente cliente MCP (stdio, cero dependencias nuevas)                                                           |
| `lsp`        | Puente LSP: diagnósticos/símbolos/definiciones/referencias                                                     |
| `web`        | Fetch + higiene SSRF de cinco piezas                                                                           |
| `compaction` | Compactación de conversaciones largas: enmascaramiento surfaceOp + flujo durable de cinco pasos                |
| `checkpoint` | Reversión por instantáneas: almacén de blobs sha256 + `/rewind` reversión transaccional en dos fases           |
| `obs`        | Observabilidad: rollups + `obs_query` + `/obs` + alertas                                                       |
| `admin`      | Administración: apps_list / events_query / verbos de instalación                                               |
| `webui`      | Web en loopback (`--port` puntual, SSE + SPA)                                                                  |
| `browser`    | Automatización de navegador: puente CDP mínimo manuscrito + herramientas de navegación/instantánea/interacción |

### Pila de seguridad

- **Canalización de tres etapas**: validación → puerta (aprobación/sandbox/allowlist) → ejecución — registro durable sin rodeos.
- **Tres niveles de sandbox**: `read-only` / `workspace-write` / `danger-full-access` (seatbelt/bwrap).
- **Pares de aprobación**: `approval/asked` → `approval/decided` trazabilidad de auditoría.
- **Allowlist**: autoaprobación auditada, enumerable y revocable.
- **Aplicación de vocabulario**: verificación por máquina — los nombres mal escritos fallan ruidosamente.

### Carga y ecosistema

- **Árbol de composición**: capa por defecto + `overlay.yaml` sobrescritura a nivel de campo.
- **Instalación/montaje en dos estados**: `install` al almacén (cero efecto), `mount` escribe la fila activa.
- **Dos ámbitos**: global (oficial) / por aplicación (terceros).
- **`/reload --app`**: recarga en caliente por zona.
- **Habilidades**: SKILL.md de dos capas + revelación progresiva.

## Todo es una aplicación

La carga sigue el **modelo de centro de aplicaciones**: una aplicación es un instalable independiente (las tres fuentes de npm son el mercado — nombres de registro / git / directorios locales; sin tienda propia), e instalar por sí solo no cambia nada — la instalación la deja en el almacén; el montaje escribe la fila de composición que la activa. Las piezas oficiales se montan en el ámbito global para servir a todas las aplicaciones (el estado del operador, como la memoria, crece sobre una base compartida); las piezas de terceros se montan por aplicación (la autorización y el radio de explosión siguen a la aplicación anfitriona).

Escribir una aplicación para Berry solo requiere un `index.ts`: un `apply(ctx, config)` exportado por defecto, metadatos declarativos (dependencias inject, esquema de config, vocabulario de eventos), y todo registro pasa por `ctx.effect` — el retroceso del ámbito deshace el registro automáticamente. 27 ganchos de ciclo de vida abarcan seis capas (sesión / agente / turno / mensaje / canalización de herramientas / proveedor), con la superficie completa de observación y gobernanza abierta. Consulta la [Guía de desarrollo de aplicaciones](docs/应用开发指南.md) (en chino).

## Modelo de seguridad

- **Canalización de tres etapas**: validación de esquema → puerta (decisiones de aprobación / sandbox / allowlist) → ejecución — la única vía legal para ejecutar herramientas, con libro de cuenta duradero y sin rodeos.
- **Tres niveles de sandbox**: `read-only` / `workspace-write` / `danger-full-access`; las aplicaciones de terceros van por defecto al dominio de proceso externo (fork por fila + capa intermedia PM + capa de sandbox del SO), con subprocesses indirectos acotados por listas blancas por fila. **Las aplicaciones nacen en sandbox — los permisos se declaran, no se roban.**
- **Pares de aprobación**: cada acción de escritura deja un par de auditoría `approval/asked` / `approval/decided`; el «permitir siempre» pasa por la allowlist, enumerable y revocable.
- **Aplicación de vocabulario**: el registro de vocabulario de eventos se verifica por máquina — los nombres mal escritos fallan ruidosamente y las palabras del kernel no pueden falsificarse.

## Documentación

| Documento                                    | Contenido                                                 |
| -------------------------------------------- | --------------------------------------------------------- |
| [docs/架构总览.md](docs/架构总览.md)         | Modelo de anillos, DAG de módulos, eventos, montaje       |
| [docs/使用指南.md](docs/使用指南.md)         | Comandos CLI/TUI, directorio de datos, variables, skills  |
| [docs/应用开发指南.md](docs/应用开发指南.md) | Forma de entry.ts, servicios inject, ganchos, composición |
| [docs/开发指南.md](docs/开发指南.md)         | Cuatro puertas, disciplina de pruebas, límites            |
| [docs/运维手册.md](docs/运维手册.md)         | Datos, copias, reinicio, protecciones, diagnóstico        |

> La documentación es actualmente autoritativa en chino; las versiones en otros idiomas están planificadas junto al lanzamiento 1.0.

## Lo que Berry no es

- **No es otro framework de agentes** — un framework te da un SDK para escribir código; Berry te da una superficie de carga para instalar aplicaciones. Las piezas de capacidad son datos (instalables, desinstalables, reemplazables), no dependencias de tu proyecto.
- **No es un servicio en la nube residente** — la forma monopuesto va por defecto sin puertos ni escuchas; la interfaz web es una pieza en loopback abierta puntualmente con `--port`, y la forma daemon es una elección explícita.
- **Sin promesas de autonomía** — pares de aprobación, frenos presupuestarios, una allowlist enumerable y revocable: la autoridad de escritura queda en personas y libros de cuenta, y cada fragmento de poder que recibe el modelo tiene superficie de auditoría.
- **Sin un segundo formato de ecosistema** — las aplicaciones son paquetes npm (distribución de tres fuentes), las habilidades son directorios SKILL.md, la configuración es overlay.yaml: sin tienda propia, sin formato de contenedor propio.

## Estado del proyecto

`1.0.0-alpha` — ventana de prelanzamiento: las API, el vocabulario y las superficies de tipos evolucionan libremente; los cambios rompientes se integran en commits atómicos únicos. Búsqueda, ejecución de comandos, acceso web, MCP, LSP y observabilidad (agregados + alertas) están implementados; la forma de servidor multiinquilino queda aplazada hasta que la demanda real la impulse.

## Telemetría

**Cero telemetría por defecto** — esta herramienta no envía ningún paquete de red: sin estadísticas de uso, sin informes de fallos, sin comprobaciones de versión (actualizar es enteramente tu decisión). Las llamadas a modelos que configures son el único tráfico saliente. **La vida de tu Agent te pertenece solo a ti.**

Si algún día se introduce reporte, se aplican cuatro promesas: anuncio previo (Why this exists / How it works / What data is collected / How to disable it — las cuatro secciones antes de publicar), desactivado por defecto (invertir el valor por defecto es un cambio rompiente), un interruptor de apagado verificable por máquina (no una promesa), y datos mínimos (lo que pueda quedarse sin conexión, se queda).

## Contribuir

```bash
npm run dev               # TUI (tsx, registros a nivel debug por defecto)
npm test                  # suite completa de pruebas
npm run typecheck         # tsc --noEmit, dos pasadas
npm run lint:topology     # puertas de DAG de módulos + vocabulario de eventos
npm run format:check      # Prettier
```

Las cuatro puertas en verde son la precondition de cada commit. Consulta [CONTRIBUTING.md](CONTRIBUTING.md) (en chino).

## Licencia

[MIT](LICENSE) — las piezas oficiales se distribuyen con el paquete; las aplicaciones y habilidades de terceros llevan sus propias licencias.
