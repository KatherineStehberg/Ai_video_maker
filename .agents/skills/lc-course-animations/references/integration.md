# Integración y evidencia

## Agentes

Invocar `$lc-course-animations` con curso, lección, objetivo e idioma. Leer el paquete canónico de `.agents/skills/lc-course-animations/`; Claude puede descubrirlo desde su skill de referencia en `.claude/skills/`.

## Orquestador

Leer CLAUDE.md y el estado actual. Crear ticket en tasks/, usar rama de ticket y registrar resultado en reports/. No modificar datos comerciales ni fechas ajenas.
Usar API/store de producción existente sólo si su contrato permite el registro. Esta instalación no modifica data/orchestrator.json ni activa escritura automática hacia WordPress.

## AI Video Maker

Producir fuera de Git y usar el MP4 como clip en el editor multipista existente. Conservar originales y pistas de voz separadas.
Leer src/generation/orchestrator-contract.js antes de implementar un worker. La skill/CLI no reemplaza pipeline ni agrega un endpoint: un worker automático requiere implementación y prueba propias.

## Estados

| Etapa | Evidencia |
| --- | --- |
| preparado | contenido de lección y spec |
| renderizado | MP4, qa.json y decodificación |
| revisado | capturas inspeccionadas y correcciones |
| subido | URL/ID real de Medios |
| insertado | video persistente tras recarga |
| probado-como-alumno | reproducción con acceso válido |

Adaptar etiquetas al schema existente sin modificarlo. Registrar audio none/narrated; no inventar porcentajes.

## MasterStudy

Leer y preservar la lección. Subir sólo si no existe el recurso y obtener URL de Medios.
Insertar reproductor nativo con controles y objetivo/actividad breve como complemento.
TinyMCE puede eliminar style/preload/script; comprobar HTML persistente. Usar dimensiones de inserción razonables (800×450) conservando el MP4 en Full HD.
Guardar, recargar, verificar URL y probar como alumno con acceso válido. No alterar precios, matrícula ni visibilidad para simular la prueba.

