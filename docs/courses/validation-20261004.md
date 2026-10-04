# Validación de cola de cursos — 4 octubre 2026

- Paquete: 15 guiones, 5.488 palabras de narración y 96 escenas. Huellas y texto completo comprobados.
- Integración de cursos: **10/10 pruebas PASS** (`npm run courses:test`). Incluye servidor HTTP real, dashboard, acceso local, secuencia, persistencia, recuperación acotada y ausencia de duplicados.
- Diagnóstico real de este entorno Linux: FFmpeg y ffprobe disponibles; no hay una voz inglesa SAPI/Piper instalada. **No se produjeron los 15 videos**. Se requiere activar la versión actualizada en el computador de Katherine y comprobar la voz allí.
- Regresión focalizada de audio/generación: **22/23 PASS**. La prueba existente `cada escena con voz lleva la URL de su audio para la vista previa` también falla en el commit base `7f8ce05`, sin esta integración (baseline audio: 13/14). No se declara la suite completa verde.
- La suite completa presentó además un error FFmpeg de clip inválido. La repetición focalizada de generación pasó **9/9**, tanto en el baseline como con la actualización; no se atribuye esa ejecución fallida a una regresión confirmada ni se oculta.
- Calidad de voz, pronunciación, sincronía y edición de los 15 guiones: pendientes de render y revisión final. El dashboard no marca un trabajo como listo sólo porque haya un plan o un JSON.

La integración mantiene el servicio local. No hay despliegue remoto, descarga automática de modelos, servicios de pago ni publicación en WordPress.
