# Ranking Único de Hallazgos — Auditoría de Aplicación Forge

- **Repositorio:** `/Users/guido/dev/forge`
- **Slug:** `application-audit-ranking`
- **Fecha:** 2026-09-03
- **Autor:** forge-worker (coordinator, `inspect`, task `rank-audit-findings`)
- **Fuentes:** `report/api-report.md` · `report/api-fix.md` · `report/summary.md` · `report/verification.md` · `report/web-report.md` · `report/web-fix.md` · `report/mobile-report.md` · `report/mobile-fix.md`
- **Alcance:** ranking de **todos** los hallazgos reales (A, B, C, M1–M12), exactamente una vez cada uno.

---

## 1. Tabla ejecutiva

| Pos | ID | Título (una línea) | Nivel | Evidencia | Esfuerzo | Ref. |
|-----|----|--------------------|-------|-----------|----------|------|
| 1 | **A** | Manifiesto de instalación sin autenticar/validar dirige `rm`/sobrescritura arbitrarios | **Alto** | Reproducida (adversario) | Bajo–Medio | api-report §A / api-fix §A |
| 2 | **B** | Subprocesos resueltos desde `PATH` sobre `cwd` influenciable → ejecución arbitraria | **Medio** | Reproducida (adversario) | Bajo | api-report §B / api-fix §B |
| 3 | **M1** | `--to <version>` sin validar llega como *spec* a `npm/pnpm install -g` | **Medio** | Inferencia estática | Bajo | api-report §Minor #1 / api-fix §M1 |
| 4 | **M12** | Escrituras no atómicas del manifiesto + TOCTOU classify→write | **Medio** | Inferencia estática | Medio | api-report §Minor #12 / api-fix §M12 |
| 5 | **M2** | Archivos de estado corruptos crashean el CLI con stack trace | **Medio** | Inferencia estática | Bajo | api-report §Minor #2 / api-fix §M2 |
| 6 | **C** | Bloque `opencode.permissions` emitido sin validación (`unknown`, clave `permission`) | **Bajo** | Confirmada en código (no explotable) | Bajo | api-report §C / api-fix §C |
| 7 | **M3** | `parseModelMap` particiona por cada `=`; pierde segmentos en silencio | **Bajo** | Inferencia estática | Bajo | api-report §Minor #3 / api-fix §M3 |
| 8 | **M11** | `classifyPruneEntries` aborta todo el prune/uninstall ante un archivo ilegible | **Bajo** | Inferencia estática | Bajo | api-report §Minor #11 / api-fix §M11 |
| 9 | **M9** | CLI solo texto; sin `--json`; aliases `i`/`upgrade`/`ls` indocumentados | **Bajo** | Inferencia estática | Medio | api-report §Minor #9 / api-fix §M9 |
| 10 | **M6** | `JSON.stringify` usado como serialización TOML (Codex) sin escape correcto | **Bajo** | Inferencia estática | Medio | api-report §Minor #6 / api-fix §M6 |
| 11 | **M4** | Orden no determinista en `forge-ai list` | **Bajo** | Inferencia estática | Bajo | api-report §Minor #4 / api-fix §M4 |
| 12 | **M10** | Fallos de red del version-check invisibles (silenciados) | **Bajo** | Inferencia estática | Bajo | api-report §Minor #10 / api-fix §M10 |
| 13 | **M8** | Guarda de auto-ejecución vestigial (`import.meta.url === argv[1]`) frágil | **Bajo** | Inferencia estática | Bajo | api-report §Minor #8 / api-fix §M8 |
| 14 | **M7** | Campo Claude-only `user-invocable` condiciona lógica de Grok/OpenCode | **Bajo** | Inferencia estática | Bajo | api-report §Minor #7 / api-fix §M7 |
| 15 | **M5** | I/O secuencial en bucles calientes (N+1) | **Bajo** | Inferencia estática | Bajo | api-report §Minor #5 / api-fix §M5 |

**Leyenda de evidencia.**
- **Reproducida (adversario):** `verification.md` §4 ejecutó el mecanismo de extremo a extremo en directorios temporales aislados y lo confirmó (A: borrado de archivo fuera de alcance; B: ejecución del shim malicioso con marcador `PWNED`).
- **Confirmada en código (no explotable):** ruta verificada contra fuente; constituye brecha de validación/contrato, sin camino de explotación.
- **Inferencia estática:** mecanismo verificado contra fuente (Lens 2 de `verification.md`), pero no ejecutado como explotación.

---

## 2. Superficies Web y Mobile: N/A, excluidas del ranking

`report/web-report.md` y `report/mobile-report.md` determinan **Not Applicable** — no "no auditado" — y `verification.md` §3 lo confirma de forma independiente:

- **Web:** `package.json` declara solo 3 dependencias runtime CLI (`@clack/prompts`, `picocolors`, `yaml`); `#files` no publica activos estáticos; en `src/` no existe `listen(`/`createServer`/enrutado. El único HTTP saliente es `src/version-check.ts` (ya cubierto en `api-report.md`).
- **Mobile:** `package.json` apunta a Node (`engines.node >=20`, `bin` → `bin/forge-ai.mjs`); no hay Swift/Kotlin/Java/Dart/Flutter/RN/Expo/Capacitor en `src/` (los únicos aciertos de "expo" son el substring de `export`).

No existe superficie de ataque web ni móvil, por lo que **no aportan hallazgos y no entran en el ranking**. `web-fix.md` y `mobile-fix.md` son, por construcción, tablas "sin hallazgos → sin fixes". El total del ranking es exactamente **15 hallazgos (A, B, C, M1–M12)**, todos provenientes del backend/CLI.

---

## 3. Ranking detallado

> Los identificadores `M1–M12` corresponden, en orden, a los 12 puntos de "Minor Issues & Smells" de `api-report.md` (§Minor #1–#12); `api-fix.md` los etiqueta explícitamente `M1–M12`.

### 1. A — Manifiesto de instalación sin autenticar/validar dirige borrado y sobrescritura arbitrarios

- **Nivel:** Alto
- **Evidencia:** **Reproducida (adversario).** `verification.md` §4 inyectó un `user-manifest.json` envenenado con `path` apuntando a un archivo fuera de cualquier directorio gestionado y `checksum` auto-calculado; `loadManifest → staleEntries → classifyPruneEntries → pruneEntries` **borró el archivo víctima** (`RESULT: victim file WAS DELETED`).
- **Motivo de la posición (criterios):**
  - *Severidad técnica:* destrucción de datos/integridad (`rm(entry.path,{force:true})` sin guarda de alcance).
  - *Explotabilidad:* **confirmada**, no inferida — el único hallazgo con pérdida de datos demostrada de extremo a extremo.
  - *Prerrequisitos:* escritura a nivel de usuario en `~/.forge/state/` (atacante local **o un proceso agente comprometido — la clase de proceso que Forge mismo genera y al que concede herramientas de archivo**) + el usuario ejecuta `update --prune`/`uninstall` con `--yes`/`--force` (o consiente interactivamente).
  - *Impacto/alcance:* borrado o sobrescritura de **cualquier archivo legible por el proceso**; la rama `checksum-mismatch` también borra (con backup) bajo `--force`, así que el checksum **no** es una compuerta real en ese camino (nota del propio `verification.md` §4).
  - *Urgencia:* máxima — es el hallazgo con mayor peso de integridad y el único con borrado probado.
- **Escenario de impacto:** un agente de IA comprometido (al que Forge da acceso a archivos) o un proceso local escribe una entrada de manifiesto hacia `~/Documentos/importante.txt`; la siguiente ejecución rutinaria de `forge-ai update --prune` lo elimina silenciosamente.
- **Recomendación inmediata:** validar `entry.path` contra una lista blanca de raíces por alcance + validar esquema y formato de `checksum` **antes** de toda operación destructiva (spec completa en `api-fix.md §A`); re-verificar adversarialmente tras el fix.
- **Referencia:** [`api-report.md §A`](./api-report.md) · [`api-fix.md §A`](./api-fix.md) · [`verification.md §4-A`](./verification.md)

### 2. B — Subprocesos resueltos desde `PATH` sobre `cwd` influenciable

- **Nivel:** Medio
- **Evidencia:** **Reproducida (adversario).** `verification.md` §4 colocó un shim `opencode` malicioso primero en `PATH` y ejecutó el `discoverOpenCodeModels` compilado: el shim se ejecutó con los privilegios del usuario (marcador `PWNED` presente) y su stdout se parseó como lista de modelos.
- **Motivo de la posición (criterios):**
  - *Severidad técnica:* ejecución arbitraria de código (RCE) en una herramienta de desarrollo — la clase técnica más grave, **pero** en contexto local.
  - *Explotabilidad:* **confirmada** de extremo a extremo.
  - *Prerrequisitos:* ejecutar `forge-ai install/configure` (descubrimiento) o `self-update` (package managers) en un directorio donde un `opencode`/`pnpm`/`npm` malicioso esté antes en `PATH` (p. ej. `node_modules/.bin` o una entrada relativa). El patrón documentado `forge-ai install --source .` lo hace prácticamente relevante.
  - *Impacto/alcance:* RCE con los privilegios del usuario (todo lo que el usuario puede hacer).
  - *Urgencia:* alta, pero **por debajo de A** según la evidencia de cierre: el adversario independiente ratificó que "Medium es bien fundado" (`verification.md` §4) porque el disparador exige que el usuario apunte la herramienta a un checkout no confiable — una acción de usuario conspicua — mientras que A se activa por un proceso comprometido de forma más silenciosa. Se mantiene el nivel "Medio" del informe y del cierre, sin degradarlo ni inflarlo.
- **Escenario de impacto:** un repositorio malicioso publica un `opencode` en `node_modules/.bin`; al hacer `forge-ai install --source .` en él, el binario atacante se ejecuta con los privilegios del desarrollador (exfiltración/persistencia).
- **Recomendación inmediata:** resolver los binarios a ruta absoluta + lista blanca de comandos y eliminar `cwd` del `spawnSync` de descubrimiento (`api-fix.md §B`); re-verificar adversarialmente tras el fix.
- **Referencia:** [`api-report.md §B`](./api-report.md) · [`api-fix.md §B`](./api-fix.md) · [`verification.md §4-B`](./verification.md)

### 3. M1 — `--to <version>` sin validar llega como spec a `npm/pnpm install -g`

- **Nivel:** Medio
- **Evidencia:** Inferencia estática (mecanismo confirmado en fuente; no explotado).
- **Motivo:** el más severo de los menores porque cruza un límite de proceso hacia el gestor de paquetes: `${PACKAGE}@${version}` con `version` controlado por el usuario. El spawn por array-argv evita la inyección de shell, pero `--to "github:user/repo"` (o un valor con flags) alcanza `pnpm/npm install -g` como spec y puede resolver fuentes no-registro. Severidad Low–Med en informe; probabilidad baja (requiere que el usuario pase un `--to` malicioso), pero impacto = instalación de código ajeno. Esfuerzo bajo (validar semver/`latest`).
- **Escenario de impacto:** ingeniería social induce `forge-ai self-update --to "github:evil/repo"` y se instala un paquete de terceros en lugar de la versión oficial.
- **Recomendación inmediata:** aceptar solo semver o `latest` (`api-fix.md §M1`).
- **Referencia:** [`api-report.md §Minor #1`](./api-report.md) · [`api-fix.md §M1`](./api-fix.md)

### 4. M12 — Escrituras no atómicas del manifiesto + TOCTOU classify→write

- **Nivel:** Medio
- **Evidencia:** Inferencia estática.
- **Motivo:** raíz de integridad del mismo subsistema que A/M2. (a) `saveManifest`/`saveModelPreferences` escriben directo (sin temp+`rename`), de modo que una escritura interrumpida deja el estado corrupto que M2 luego crashea; (b) ventana TOCTOU entre `classifyFile` (lee+hash) y `writeOutputs` (reescribe), benigna para una herramienta local pero real. Esfuerzo medio; impacto = integridad/disponibilidad del estado.
- **Escenario de impacto:** interrupción (kill/fallo de disco) durante `install` deja `manifest.json` a medias; el siguiente arranque falla (M2) o una carrera entre clasificación y escritura sobrescribe un archivo cambiado.
- **Recomendación inmediata:** temp-file + `rename` atómico y re-chequeo de checksum inmediato antes de sobrescribir (`api-fix.md §M12`). Hacerlo junto con M2.
- **Referencia:** [`api-report.md §Minor #12`](./api-report.md) · [`api-fix.md §M12`](./api-fix.md)

### 5. M2 — Archivos de estado corruptos crashean el CLI con stack trace

- **Nivel:** Medio
- **Evidencia:** Inferencia estática.
- **Motivo:** `loadManifest`/`loadModelPreferences` re-lanzan cualquier error no-`ENOENT`; un `manifest.json`/`user-model-preferences.json` a medias produce una excepción no capturada (impresa por `bin/forge-ai.mjs`) en lugar de un mensaje recuperable. Impacto = disponibilidad/UX (herramienta rota tras una escritura truncada); esfuerzo bajo; se resuelve de raíz junto con M12 (atomicidad) y con recuperación `SyntaxError` en load.
- **Escenario de impacto:** un `pnpm install` interrumpido deja estado corrupto; `forge-ai list`/`install` crashea sin diagnóstico accionable.
- **Recomendación inmediata:** capturar `SyntaxError`/shape-mismatch separado de `ENOENT` y emitir "estado corrupto; re-ejecuta `forge-ai install`" (`api-fix.md §M2`), idealmente en el mismo cambio que M12.
- **Referencia:** [`api-report.md §Minor #2`](./api-report.md) · [`api-fix.md §M2`](./api-fix.md)

### 6. C — Bloque `opencode.permissions` emitido sin validación (`unknown`)

- **Nivel:** Bajo
- **Evidencia:** Confirmada en código, **no explotable** (brecha de validación/contrato; `verification.md` §4 la ratifica como gap, no exploit).
- **Motivo:** `ProductConfig.permissions?: unknown` y `opencode.ts` serializa el valor crudo bajo la clave singular `permission` sin validación de forma/tamaño, divergiendo de Claude/Grok (`stringList`/`patternList`) y Codex (`safeSandboxModes`). Sin pérdida de datos ni ejecución de código: solo instalación silenciosa de configuración malformada. Por eso cierra el bloque intermedio y queda en nivel Bajo (pese al "Low–Medium" del informe, su ausencia de explotabilidad la sitúa por debajo de M1/M12/M2). Incertidumbre residual (canónico `permission` singular, no resoluble desde el repo) ya documentada en `verification.md` §7.
- **Escenario de impacto:** un `opencode.permissions` malformado/sobredimensionado se instala sin diagnóstico, produciendo un agente OpenCode con permisos inesperados.
- **Recomendación inmediata:** validar la forma/limites y reconciliar la clave `permission`/`permissions` (`api-fix.md §C`).
- **Referencia:** [`api-report.md §C`](./api-report.md) · [`api-fix.md §C`](./api-fix.md) · [`verification.md §4-C`](./verification.md)

### 7. M3 — `parseModelMap` particiona por cada `=` y pierde segmentos en silencio

- **Nivel:** Bajo
- **Evidencia:** Inferencia estática.
- **Motivo:** `pair.split('=')` sobre todos los `=` hace que ids de modelo con `=` (legales en OpenCode `provider/model`) se parseen mal (`name=model=x` → `{name:"model"}`), y segmentos vacíos se rechazan en lugar de dropearse. Corrección correcta de la intención del usuario, en silencio; esfuerzo bajo.
- **Escenario de impacto:** un `--model-map name=provider/model=x` instala un mapeo distinto del pretendido.
- **Recomendación inmediata:** dividir solo en el primer `=` y validar nombres (`api-fix.md §M3`).
- **Referencia:** [`api-report.md §Minor #3`](./api-report.md) · [`api-fix.md §M3`](./api-fix.md)

### 8. M11 — Prune/uninstall aborta ante un único archivo ilegible

- **Nivel:** Bajo
- **Evidencia:** Inferencia estática.
- **Motivo:** `classifyPruneEntries` re-lanza cualquier error no-`ENOENT`; un archivo gestionado con permiso denegado hace fallar todo `update --prune`/`uninstall`. Impacto = fricción real en una operación destructiva (usuario no puede desinstalar); esfuerzo bajo.
- **Escenario de impacto:** un archivo gestionado con `chmod 000` bloquea por completo el `uninstall`.
- **Recomendación inmediata:** marcar como `skipped` con razón `unreadable` y advertir, en lugar de re-lanzar (`api-fix.md §M11`).
- **Referencia:** [`api-report.md §Minor #11`](./api-report.md) · [`api-fix.md §M11`](./api-fix.md)

### 9. M9 — CLI solo texto; sin `--json`; aliases indocumentados

- **Nivel:** Bajo
- **Evidencia:** Inferencia estática.
- **Motivo:** salida solo texto y exit codes binarios impiden scripting fiable; `i`/`upgrade`/`ls` aceptados pero ausentes de `showUsage`. Sin riesgo de seguridad; impacto = contrato/automatización; esfuerzo medio.
- **Escenario de impacto:** un wrapper de CI no puede consumir `forge-ai list`/plan de forma estructurada; usuarios descubren aliases por accidente.
- **Recomendación inmediata:** añadir `--json` (o `FORGE_OUTPUT=json`) y documentar aliases/exit codes (`api-fix.md §M9`).
- **Referencia:** [`api-report.md §Minor #9`](./api-report.md) · [`api-fix.md §M9`](./api-fix.md)

### 10. M6 — `JSON.stringify` como serialización TOML (Codex) sin escape correcto

- **Nivel:** Bajo
- **Evidencia:** Inferencia estática.
- **Motivo:** `tomlString` emite `name`/`description`/`developer_instructions`/`model` como literales JSON; el escape JSON y TOML no son idénticos, y `developer_instructions` lleva el cuerpo completo. Probabilidad baja (los cuerpos son contenido controlado de Forge), pero un cuerpo con control-chars/Unicode/multilínea generaría TOML Codex inválido. Esfuerzo medio.
- **Escenario de impacto:** un artifact con contenido no-ASCII/control produce un agente Codex con TOML malformado.
- **Recomendación inmediata:** escape TOML básico explícito (`tomlBasicString`) + tests golden (`api-fix.md §M6`).
- **Referencia:** [`api-report.md §Minor #6`](./api-report.md) · [`api-fix.md §M6`](./api-fix.md)

### 11. M4 — Orden no determinista en `forge-ai list`

- **Nivel:** Bajo
- **Evidencia:** Inferencia estática.
- **Motivo:** `listInstalls` itera `readdir` en orden crudo (a diferencia de `discoverSources`, que ordena). Impacto = reproducibilidad/testabilidad/scripting; esfuerzo bajo.
- **Escenario de impacto:** dos ejecuciones de `forge-ai list` imprimen proyectos en orden distinto, rompiendo diffs/scripts.
- **Recomendación inmediata:** ordenar por `projectPath` antes de devolver (`api-fix.md §M4`).
- **Referencia:** [`api-report.md §Minor #4`](./api-report.md) · [`api-fix.md §M4`](./api-fix.md)

### 12. M10 — Fallos de red del version-check invisibles

- **Nivel:** Bajo
- **Evidencia:** Inferencia estática.
- **Motivo:** `fetchLatest` traga toda falla (red/no-200/JSON malformado) sin log y `checkLatestVersion` hace `.catch(()=>undefined)`. Sin impacto de seguridad; impacta diagnosticabilidad (proxy/registro roto invisible). Esfuerzo bajo.
- **Escenario de impacto:** un usuario con proxy roto nunca ve que las comprobaciones de versión fallan, creyendo estar al día.
- **Recomendación inmediata:** callback `log`/`warn` opcional con gate `FORGE_DEBUG` (`api-fix.md §M10`).
- **Referencia:** [`api-report.md §Minor #10`](./api-report.md) · [`api-fix.md §M10`](./api-fix.md)

### 13. M8 — Guarda de auto-ejecución vestigial (`import.meta.url === argv[1]`)

- **Nivel:** Bajo
- **Evidencia:** Inferencia estática.
- **Motivo:** la comparación se rompe bajo symlinks/rutas no normalizadas/`tsx`/`ts-node`; como `bin/forge-ai.mjs` ya llama a `main()` explícitamente, la guarda es vestigial y solo arriesga doble-ejecución o no-ejecución. Impacto funcional remoto; esfuerzo bajo.
- **Escenario de impacto:** invocación por symlink arriesga un borde de doble `main()` o `main()` que nunca corre.
- **Recomendación inmediata:** eliminar la guarda o reemplazarla por equivalente robusto (`api-fix.md §M8`).
- **Referencia:** [`api-report.md §Minor #8`](./api-report.md) · [`api-fix.md §M8`](./api-fix.md)

### 14. M7 — Campo Claude-only `user-invocable` condiciona lógica de Grok/OpenCode

- **Nivel:** Bajo
- **Evidencia:** Inferencia estática.
- **Motivo:** `renderGrokSkill`/`renderOpenCodeSkill` leen `artifact.claude?.['user-invocable']` para decidir el warning de "no ocultable en esta plataforma". Intencional pero es un acoplamiento multiplataforma (clave de una plataforma filtrándose al comportamiento de otras). Impacto = mantenibilidad; esfuerzo bajo.
- **Escenario de impacto:** un refactor del campo Claude cambia silenciosamente diagnósticos de Grok/OpenCode.
- **Recomendación inmediata:** helper documentado `isBackgroundOnly(artifact)` o campo explícito por plataforma (`api-fix.md §M7`).
- **Referencia:** [`api-report.md §Minor #7`](./api-report.md) · [`api-fix.md §M7`](./api-fix.md)

### 15. M5 — I/O secuencial en bucles calientes (N+1)

- **Nivel:** Bajo
- **Evidencia:** Inferencia estática.
- **Motivo:** `classifyDestinations`, `discoverArtifacts` y `listInstalls` esperan seriamente por archivo (a diferencia de `buildManifest`, que usa `Promise.all`). Solo rendimiento en instalaciones/listados grandes; esfuerzo bajo. Menor urgencia de todo el ranking.
- **Escenario de impacto:** latencia de muro más alta al instalar/listar muchos artefactos.
- **Recomendación inmediata:** `Promise.all` preservando orden (`api-fix.md §M5`).
- **Referencia:** [`api-report.md §Minor #5`](./api-report.md) · [`api-fix.md §M5`](./api-fix.md)

---

## 4. Resolución de contradicciones entre reportes

Revisión cruzada de los cuatro documentos fuente frente a `verification.md` como evidencia de cierre:

1. **A/B "inferencia" vs. "probado".** `api-report.md` y `summary.md` calificaron A y B como "mecanismo confirmado, explotabilidad no demostrada (inferencia)". `verification.md` §4 suministró la evidencia faltante (borrado de archivo para A; ejecución del shim con marcador `PWNED` para B). **Resolución:** A y B se tratan como **reproducidas**, no inferidas; el resto (C y M1–M12) permanece como confirmado-en-código/inferencia. No hay contradicción sustantiva, solo cierre de una pregunta abierta.

2. **Nivel de B.** Existe tensión aparente entre "RCE es la clase más grave" y el "Medium" del informe. **Resolución:** el adversario independiente ratificó explícitamente "Medium (arbitrary code execution in a dev tool) is well-founded" (`verification.md` §4), y el disparador de B (apuntar la herramienta a un checkout no confiable) es una acción de usuario más conspicua que el disparador de A (proceso comprometido → borrado silencioso). Se mantiene A=Alto > B=Medio, coherente con el cierre.

3. **Orden del bloque intermedio.** `summary.md` §5 ordenaba M2 > M12 > M1 > C; este ranking propone M1 > M12 > M2 > C. No es una contradicción de hechos, sino un desempate de criterios: el informe agrupó los cuatro como "Low–Med" y ordenó por severidad×esfuerzo×impacto; este ranking usa *explotabilidad/alcance* como desempate — M1 (cruza límite hacia `npm/pnpm install`) y M12 (raíz de integridad) superan a M2 (síntoma de disponibilidad) y C (gap no explotable, degradado a Bajo). Los hechos subyacentes son idénticos y están ratificados en `verification.md` Lens 2.

4. **Correcciones menores ya aplicadas** (por `verification.md` §3, no por este ranking): nombre real del manifiesto user-scope (`user-manifest.json`), redacción de M3 ("cada `=`", no "el primer `=`"), conteo de tests (~101, no ~90) y aclaración sobre la inexistencia de `node:findExecutable`. Este ranking las hereda; ninguna altera la severidad.

---

## 5. Secuencia recomendada de remediación por fases

| Fase | Hallazgos | Objetivo | Notas |
|------|-----------|----------|-------|
| **Fase 1 — Cierre de vulnerabilidades probadas** | **A, B** | Eliminar el borrado arbitrario y la ejecución de binarios sombra | Esfuerzo bajo–medio. Tras el fix, re-verificar con `forge-adversary` (reproducir la condición de disparo real, no una limpia), igual que se hizo para probar el mecanismo. |
| **Fase 2 — Robustez del estado + límite del subproceso** | **M12, M2, M1** | Escrituras atómicas + recuperación ante estado corrupto + validación de `--to` | M12 y M2 son dos mitades del mismo cambio (atomicidad + recuperación `SyntaxError`). M1 es independiente y de bajo esfuerzo. |
| **Fase 3 — Paridad de validación y contrato** | **C, M3, M4** | Validar `opencode.permissions`, endurecer `parseModelMap`, ordenar `list` | Restauran paridad con los otros adaptadores y corrigen la intención del usuario. |
| **Fase 4 — Robustez operativa y observabilidad** | **M11, M9, M10** | No abortar prune, salida `--json`, observabilidad del version-check | Mejora de operación diaria y automatización. |
| **Fase 5 — Higiene técnica (opcional)** | **M6, M8, M7, M5** | Escape TOML, eliminar guarda vestigial, desacoplar `user-invocable`, paralelizar I/O | Sin urgencia de seguridad; puede programarse con mantenimiento rutinario. |

**Validación transversal obligatoria** (de `api-fix.md`): `pnpm typecheck` y `pnpm test` deben pasar tras cada fase; ejecutar `pnpm run generate-fixtures` y tratar diffs de golden como intencionales solo donde un fix altera salida renderizada (C, M6); **ningún** cambio puede debilitar los tests de conformidad que bloquean la postura de menor privilegio del orquestador (`tests/forge-cli.test.ts:1122–1217`).

---

## 6. Cobertura (auto-chequeo)

Cada ID aparece exactamente una vez, en orden decreciente de gravedad:

- **A** → posición 1 ✓
- **B** → posición 2 ✓
- **M1** → posición 3 ✓
- **M12** → posición 4 ✓
- **M2** → posición 5 ✓
- **C** → posición 6 ✓
- **M3** → posición 7 ✓
- **M11** → posición 8 ✓
- **M9** → posición 9 ✓
- **M6** → posición 10 ✓
- **M4** → posición 11 ✓
- **M10** → posición 12 ✓
- **M8** → posición 13 ✓
- **M7** → posición 14 ✓
- **M5** → posición 15 ✓

Total: 15/15, sin omisiones ni duplicados. Web y Mobile están excluidos por N/A (no aportan hallazgos).
