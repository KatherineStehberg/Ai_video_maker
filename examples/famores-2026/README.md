# Famores 2026 — videos en movimiento (sin narración)

Cuatro videos verticales 1080×1920 (Reels/Stories), 18 s, 24 fps, H.264 yuv420p, **sin audio / sin narración**, hechos a partir del contenido de los flyers Famores 2026 v3 (precios del Catálogo Famores 2026 en Gamma). Los flyers no se modifican.

| Spec | Producto | Precio |
| --- | --- | --- |
| `specs/famores-set-pintado.json` | Set Standard pintado · FAM-STD-PIN-14 | $48.000 |
| `specs/famores-set-sin-pintar.json` | Set Standard sin pintar · FAM-STD-NAT-14 | $30.000 |
| `specs/famores-cajitas-pintadas.json` | Cajitas de mascotas pintadas · FAM-MAS-PIN-03/06/08 | $22.500–$59.000 |
| `specs/famores-cajitas-sin-pintar.json` | Cajitas de mascotas sin pintar · FAM-MAS-NAT-03/06/08 | $15.500–$40.000 |

Precios finales en CLP, IVA incluido.

## Cómo se hizo (mismo método que la skill `lc-course-animations`)

- `template.html`: plantilla Famores (crema/café/teal) con línea de tiempo GSAP determinista: intro logo → título + SKU → revelado de foto con zoom lento (alterna *sin logo / con logo* en cajitas) → atributos → precio con conteo → contacto (famores.com · WhatsApp +56 9 6205 2499 · @famoresporelmundo).
- `build.cjs`: inyecta el bloque GSAP 3.15.0 (con su aviso de licencia) desde `.agents/skills/lc-course-animations/assets/four-step.html` y el spec JSON.
- `render.cjs`: copia del render de la skill con tamaño parametrizable (`VIDEO_W`, `VIDEO_H`). Mismas verificaciones: 5 capturas QA, ≥3 distintas, ffprobe (h264, yuv420p, 24/1, nº de cuadros), decodificación completa, `qa.json` con SHA-256.
- `img/` (no versionado aquí: binarios): fotos del Catálogo Famores 2026 en Gamma (`7mqu5t4b46c2nh0`) y logo. Nombres esperados:
  - `set_pin.jpg` ← set pintado (agent-uploads/TLYXGpoTCNxjlDbevVSz3.png)
  - `set_nat_crop.jpg` ← set sin pintar (agent-uploads/2-asDUImF-Yr15wDooEHx.png), recorte de la fila de tamaños
  - `pin06.jpg`, `pin06logo.jpg`, `nat06.jpg`, `nat06logo.jpg` ← fotos FAM-MAS-PIN-06 / NAT-06 sin y con logo (960×960)
  - `logo.png` ← logo Famores con fondo transparente

```bash
cd examples/famores-2026
node build.cjs specs/famores-set-pintado.json famores-set-pintado.html
VIDEO_W=1080 VIDEO_H=1920 node render.cjs famores-set-pintado.html ../../tmp/famores-set-pintado
```
(Requiere `playwright-core` de `.agents/skills/lc-course-animations/scripts/` o `playwright`, Chromium y ffmpeg.)

## Resultado del render (2026-11-01)

| Video | Cuadros | Duración | SHA-256 |
| --- | --- | --- | --- |
| famores-set-pintado.mp4 | 432 | 18s | `c7d76a443cb3f5b47e5a40a9987ebfba860f9c622d5518de6d4748c0f95810ed` |
| famores-set-sin-pintar.mp4 | 432 | 18s | `48a16140046b3cdf1276c48e67876531796f65a804111a5ba6cba73a28fc82ba` |
| famores-cajitas-pintadas.mp4 | 432 | 18s | `30c72c7990882362d7d77b27c2552fdbbc2892e73ac0489842737506391c980b` |
| famores-cajitas-sin-pintar.mp4 | 432 | 18s | `1c6e89deb77b9f29cc2f8f8c4f1d67e31d7c6431dc99e8a854bac538b5d3bd29` |

Los MP4 **no se versionan en Git** (indicación de la skill: producir fuera de Git y usar el MP4 como clip en el editor multipista). Estado: preparado → renderizado → revisado (capturas QA inspeccionadas). No publicados en redes.
