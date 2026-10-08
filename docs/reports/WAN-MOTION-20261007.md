# Integración de movimiento generativo Wan — 7 de octubre de 2026

Se incorpora `visualMode: "wan"` al generador por prompt, al editor y al contrato
del orquestador. Cada escena pendiente puede crear un clip original a partir
del prompt visual. Al regenerar una escena con imagen, esa imagen se conserva
como referencia para imagen-a-video; un error no elimina el recurso anterior.

## Conexiones implementadas

- **Local:** ejecuta el `generate.py` oficial de Wan2.2 con TI2V-5B y pesos
  configurados por el operador. Sin descarga automática ni llamadas de pago.
- **Space:** cliente Gradio opcional 2.7.2, ID y contrato de parámetros
  configurados exclusivamente en backend. No hay preset verificado.
- **Comprobar conexión:** POST protegido; no genera clips, no duplica Spaces
  y no compra GPU/créditos. Comprobar la API o CUDA no prueba la inferencia.

Los resultados se verifican con ffprobe, se guardan con procedencia y se
reutilizan por huella de prompt, referencia, formato, conexión y variante.
Regenerar produce una variante nueva. Se procesa un solo clip simultáneamente,
con límite de 30 minutos por clip y hasta 8 escenas pendientes por defecto.
El modo Wan no usa Pexels, imágenes estáticas o mock como sustitución ante fallo.
Regenerar una escena procesa sólo su visual; las demás pendientes no consumen GPU.

## Verificación realizada

- 10 pruebas nuevas Wan: desactivación, contrato y persistencia, CLI Python
  sin shell, cache y variantes, referencia válida, MP4 inválido, límite de lote,
  exclusión de escenas, recursos existentes, concurrencia, fallo sin reintento,
  regeneración aislada/restauración, montaje real, Space simulado y guardas HTTP.
- 99 pruebas anteriores seleccionadas aprobadas: generación, editor, medios,
  movimiento de clips, voces Edge, idiomas, audio y estudio. Total: 109 pruebas
  distintas aprobadas. El último rerun de generación+Wan pasó 19/19 tras ajustar
  el aviso de costos. No se declara aprobada la suite completa del repositorio.
- FFmpeg generó clips de prueba y MP4 finales reales; ffprobe verificó video y
  duración. El modelo local y Gradio se simularon para probar la integración:
  esos fixtures no son ejemplos de calidad de Wan.
- Smoke DOM: selector Wan, acción de guardado y POST de comprobación protegido,
  además de selección de clips y muestras de voz. No sustituye una revisión
  visual y auditiva en navegador real.
- Sintaxis JavaScript/Python y `git diff --check`.

Las pruebas se ejecutan en serie, como establece el lanzador existente del
repositorio; una ejecución paralela inicial produjo interferencia durante un
render, y una errata en el CLI simulado de prueba se corrigió antes de verificar.

## Pendiente para activar y validar calidad

Este entorno no tiene herramienta NVIDIA ni PyTorch instalado. No se descargaron
pesos ni se alquiló GPU. El demo oficial Wan-AI/Wan-2.2-5B no respondió a la
consulta de fuente desde este entorno (timeout/fallo de acceso); no se sometió
una generación remota ni se afirma que su API esté disponible.

Hace falta instalar el modelo en GPU compatible o seleccionar un Space con API
accesible y condiciones de uso adecuadas, configurar `.env`, comprobar conexión
y generar una escena real. Después evaluar movimiento, coherencia con la imagen,
tiempo, resolución y sincronización con voz antes de producir un curso completo.
La configuración oficial TI2V-5B indica GPU de 24 GB de VRAM o más.

Los clips son cortos y pueden repetirse para cubrir la narración. 1:1 se recorta
en el montaje. No se implementa continuidad de personajes, múltiples tomas
encadenadas ni un servicio alojado gratuito ilimitado.

## Fuentes de la integración

- [Wan2.2 oficial y requisitos](https://github.com/Wan-Video/Wan2.2)
- [CLI oficial](https://github.com/Wan-Video/Wan2.2/blob/main/generate.py)
- [Cliente Python Gradio](https://www.gradio.app/docs/python-client/client)
- [Cuotas ZeroGPU](https://huggingface.co/docs/hub/spaces-zerogpu)

Las instrucciones de instalación y los parámetros se encuentran en README y
`.env.example`. Los cambios aún requieren integrar el PR y actualizar la
instalación local de la usuaria.
