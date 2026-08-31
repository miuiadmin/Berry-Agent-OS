<p align="center">
  <strong>Berry</strong><br>
  El sistema operativo para aplicaciones de IA
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/berryagent"><img alt="npm" src="https://img.shields.io/badge/version-1.0.0--alpha-blue?style=flat-square"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-green?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
  <img alt="telemetry" src="https://img.shields.io/badge/telemetry-0-brightgreen?style=flat-square">
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <strong>Español</strong> ·
  <a href="README.fr.md">Français</a>
</p>

---

El kernel de Berry hace exactamente cuatro cosas — **instalar, ejecutar, proteger, almacenar** — y todo lo demás se instala como una aplicación sobre el árbol de composición. Los modelos y las herramientas cambian cada mes; tus credenciales, memoria, historial de confianza, presupuestos y libros de cuenta se acumulan una sola vez. Berry custodia estas cinco piezas de estado del operador, y cada aplicación que instalas crece sobre el mismo estado — la siguiente simplemente continúa donde terminó la anterior.

Las aplicaciones tienen tres formas según el eje de tipos: **aplicaciones (se lanzan) / extensiones (se invocan) / servicios (se consumen)** — incluso la experiencia del primer arranque vive fuera del kernel: el valor por defecto de fábrica es la aplicación de agente de programación **coder** (ensamblado puramente por manifiesto), con la aplicación de conversación oficial `chat` como ancla de reserva. La doble autoevolución (evolución de uso + evolución de habilidades) sigue el camino emergente: sin planificador central, el kernel solo aporta primitivas.

**Objetivo mínimo: la capa por defecto de fábrica alcanza el nivel de uso diario de Codex / Claude Code.**

**26** módulos (todos con código) · **35** ganchos de ciclo de vida · **16** tipos de eventos durables · **12** piezas oficiales (todas desinstalables) · **2.400+** pruebas · **0** telemetría.

## Tabla de contenidos

- [Por qué Berry](#por-qué-berry)
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

## Por qué Berry

El verdadero activo de una aplicación de IA no es el modelo — los modelos cambian cada mes — es el **estado del operador**: credenciales, memoria, historial de confianza, presupuestos, libros de cuenta. Hoy usas una aplicación de conversación, mañana un agente de programación, pasado mañana una aplicación de limpieza de datos. Todas deberían crecer sobre el mismo estado en lugar de empezar de cero cada vez.

Berry responde a esto al estilo de un sistema operativo:

- **Kernel mínimo**: el kernel fijo hace cuatro cosas — instalar (carga de aplicaciones y contexto), ejecutar (bucle del agente), proteger (seguridad y aprobaciones), almacenar (sesiones y credenciales). 25 módulos en un DAG unidireccional, reforzado por puertas de máquina — el kernel no se puede desinstalar y sus responsabilidades no pueden hincharse.
- **Todo es una aplicación**: la conversación es una aplicación, el agente de programación es una aplicación, la memoria es una aplicación — incluso el puente MCP y la interfaz web son aplicaciones. Las aplicaciones se instalan, desinstalan y sustituyen; quita cualquiera y el bucle central sigue funcionando.
- **Sesiones con origen en eventos**: una conversación es un registro de eventos de solo adición (SQLite WAL); el historial del modelo es una proyección del registro. Enmascaramiento, bifurcación, recuperación y repetición se sustentan en la semántica del registro — tu historial es tu dato.

## Un vistazo a la arquitectura

```text
            ┌─────────────────────────────────────────────┐
            │  Kernel fijo (Ring 0): instalar · ejecutar  │
            │  · proteger · almacenar — DAG unidireccional│
            │  de 25 módulos, vigilado por máquina        │
            └──────────────────┬──────────────────────────┘
                               │ árbol de composición (capa por defecto + overlay.yaml)
        ┌──────────┬──────────┼──────────────┬───────────┐
        ▼          ▼          ▼              ▼           ▼
     coder       chat      memory         goal      …12 piezas
   (app por     (conver-  (estado del    (objetivos  (cada una
    defecto)    sación)    operador)     largos)   desinstalable)
        └──────────┴──────────┴──────────────┴───────────┘
                               │ origen en eventos (registro append-only = fuente de verdad)
                               ▼
                 SQLite WAL: sesiones · credenciales · memoria · libros de cuenta
```

## Inicio rápido

```bash
# Requiere Node.js >= 22.19
git clone <este repositorio> && cd berry
npm install
npm run build
npm link          # instala el comando berry

berry             # TUI interactivo (por defecto entra en la app coder, retoma la última sesión del directorio actual)
berry run "hi"    # ejecución única (el código de salida es el resultado)
berry dump-config # diagnóstico de la composición efectiva (modelo / árbol / estado de carga, sin escribir en la base)
```

El primer arranque crea el directorio de datos en `~/.berry/`. El modelo por defecto es `anthropic/claude-sonnet-5`, sustituible con `APP_MODEL`; las credenciales de proveedor siguen la cadena de credenciales de pi-ai (variables de entorno o almacén de credenciales).

## Características de un vistazo

- **Kernel mínimo (Ring 0)**: 25 módulos en un DAG unidireccional, todos con código, vigilados por `npm run lint:topology` — nada central más allá de instalar/ejecutar/proteger/almacenar.
- **Sesiones con origen en eventos**: registro de eventos de solo adición + proyecciones derivadas; compactación de conversaciones largas (`compaction`), reversión por instantáneas del espacio de trabajo (`checkpoint` /rewind), bifurcación y adopción de sesiones — todo sustentado por el registro.
- **Paquete oficial (Ring 2, cada pieza desinstalable)**: `coder` (aplicación de agente de programación por defecto), `chat` (aplicación de conversación), `memory` (memoria: extracción/fusión/inyección de doble vía/búsqueda entre sesiones/evolución de utilidad/TTL/cadenas de versiones), `subagent` (delegación de subagentes), `goal` (máquina de estados de objetivos largos + freno presupuestario + despertar por reloj), `scheduler` (tareas programadas `/tick` — registrador launchd/crontab, sin proceso residente), `mcp` (puente cliente MCP), `lsp` (puente de servidores de lenguaje: diagnósticos/símbolos/definiciones/referencias), `web` (herramienta fetch + higiene SSRF), `obs` (observabilidad: agregados por hora + `obs_query` + resumen `/obs` + alertas), `admin` (herramientas de administración de plataforma), `webui` (interfaz web en loopback, apertura puntual con `--port`).
- **Pila de seguridad integrada**: canalización de herramientas en tres etapas (validación de esquema → puerta → ejecución), tres niveles de sandbox (read-only / workspace-write / danger-full-access, macOS seatbelt / Linux bwrap), derivación de raíces escribibles y carve-outs, pares de aprobación, allowlist (autoaprobación con auditoría).
- **Sistema de habilidades**: SKILL.md de dos capas + revelación progresiva — deja un directorio y funciona; las aplicaciones pueden llevar habilidades en su paquete.
- **Carga por árbol de composición**: capa por defecto + `overlay.yaml` con sobrescritura a nivel de campo; superficie de carga tipo centro de aplicaciones — instalación/montaje en dos estados, dos ámbitos (global / por aplicación), recarga en caliente por zona con `/reload --app`, y sandbox de proceso por defecto para las filas de terceros.

## Todo es una aplicación

La carga sigue el **modelo de centro de aplicaciones**: una aplicación es un instalable independiente (las tres fuentes de npm son el mercado — nombres de registro / git / directorios locales; sin tienda propia), e instalar por sí solo no cambia nada — la instalación la deja en el almacén; el montaje escribe la fila de composición que la activa. Las piezas oficiales se montan en el ámbito global para servir a todas las aplicaciones (el estado del operador, como la memoria, crece sobre una base compartida); las piezas de terceros se montan por aplicación (la autorización y el radio de explosión siguen a la aplicación anfitriona).

Escribir una aplicación para Berry solo requiere un `index.ts`: un `apply(ctx, config)` exportado por defecto, metadatos declarativos (dependencias inject, esquema de config, vocabulario de eventos), y todo registro pasa por `ctx.effect` — el retroceso del ámbito deshace el registro automáticamente. 35 ganchos de ciclo de vida abarcan seis capas (sesión / agente / turno / mensaje / canalización de herramientas / proveedor), con la superficie completa de observación y gobernanza abierta. Consulta la [Guía de desarrollo de aplicaciones](docs/应用开发指南.md) (en chino).

## Modelo de seguridad

- **Canalización de tres etapas**: validación de esquema → puerta (decisiones de aprobación / sandbox / allowlist) → ejecución — la única vía legal para ejecutar herramientas, con libro de cuenta duradero y sin rodeos.
- **Tres niveles de sandbox**: `read-only` / `workspace-write` / `danger-full-access`; las aplicaciones de terceros van por defecto al dominio de proceso externo (fork por fila + capa intermedia PM + capa de sandbox del SO), con subprocesses indirectos acotados por listas blancas por fila.
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

**Cero telemetría por defecto** — esta herramienta no envía ningún paquete de red: sin estadísticas de uso, sin informes de fallos, sin comprobaciones de versión (actualizar es enteramente tu decisión). Las llamadas a modelos que configures son el único tráfico saliente.

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
