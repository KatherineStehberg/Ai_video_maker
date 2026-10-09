# TASK-014 — Resultado: animaciones didácticas LC

## Entregado
- Paquete canónico `.agents/skills/lc-course-animations/` idéntico en Orquestador y AI Video Maker.
- Descubrimiento Codex mediante AGENTS.md y Claude mediante su entrada de skill.
- Plantilla HTML con GSAP 3.15.0 incorporado, ejemplo JSON, generador y renderer CLI.
- Guías de marca, procesos/datos/transformaciones, voz, publicación MasterStudy y evidencia.
- Alcance: herramienta de agentes/CLI; sin nuevos endpoints, botones o workers automáticos.

## Verificación real
- `quick_validate.py`: skill válida en ambos paquetes.
- `node --test .../scripts/build.test.cjs`: 3/3, pasos requeridos, texto seguro, duración/idioma.
- Smoke de navegador: pausa, reinicio, repeat=-1, seek hacia atrás determinista y reduced-motion; PASS.
- QA del ejemplo 32 segundos y cinco capturas del fixture inspeccionadas.
- Render del fixture de 6 segundos: H.264/yuv420p, 1920×1080, 24 fps, 144 cuadros, duración medida 6.000 s; decodificación FFmpeg completa correcta.
- SHA-256 fixture: `97459d0d6c7241b19f0ff82e97ea5df04991f18a15a6fdb75737bc328402dd44`.
- Audio: none, intencional. No afirmar narración.
- Validadores Orquestador: validate-data, validate-revenue y validate-workspace, todos correctos. Datos existentes conservados.

## Límites
- Chrome/Chromium y FFmpeg/ffprobe deben estar instalados en el equipo que renderice.
- Plantilla incluida: procesos de cuatro etapas. Datos/transformaciones requieren composición propia guiada por la skill.
- El loop corresponde al HTML; el MP4 contiene una pasada.
- Narración y publicación dependen del alcance de cada solicitud y del acceso WordPress.
- No realizar merge a master sin aprobación explícita según CLAUDE.md.
- MP4, capturas y node_modules de pruebas permanecen fuera de Git.

