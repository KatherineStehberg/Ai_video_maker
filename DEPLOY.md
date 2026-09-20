# Preparación para deploy

**Estado: NO desplegable todavía.** Este documento deja preparada la
configuración y enumera con precisión lo que falta. No hay deploy hecho, ni
autorizado, ni recomendado en el estado actual del código.

---

## 1. Bloqueadores reales (hay que resolverlos antes de exponer nada)

Estos no son detalles de configuración: son decisiones de código pendientes.

### 1.1 Las rutas principales rechazan cualquier conexión no local

`src/analysis/routes.js` y `src/edits/routes.js` comprueban la IP de origen
**de forma incondicional**, sin mirar `HOST`:

```js
if (!/^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '')) → 403
```

Detrás de un proxy (Coolify, Traefik, Nginx) la conexión llega desde la red del
contenedor, no desde `127.0.0.1`, así que **el análisis y la edición
responderían 403 a todo el mundo, incluida tú**. Poner `HOST=0.0.0.0` no lo
arregla: sólo desactiva la guarda global de `server.js`, no estas dos.

Además ambas rutas exigen que la cabecera `Host` sea `localhost` o `127.0.0.1`,
lo que un dominio real nunca cumple.

**Qué hay que decidir:** si estas guardas pasan a depender de una variable
(`ALLOW_REMOTE=true`) y qué las sustituye. No deben eliminarse sin poner algo
en su lugar, porque hoy son lo único que impide que un tercero suba un video y
gaste CPU y disco.

### 1.2 No hay autenticación de ningún tipo

No existe login, sesión, token ni clave compartida. Cualquiera que alcance la
URL podría subir archivos de hasta 2 GiB, lanzar procesos de FFmpeg y descargar
los videos de otros. **La autenticación es requisito previo al deploy**, no una
mejora posterior.

### 1.3 La exportación es una petición HTTP síncrona

`POST /api/video-edits/:id/export` mantiene la conexión abierta hasta que FFmpeg
termina. Los proxies suelen cortar a los 60 s. En material largo, el deploy
devolvería 504 aunque la exportación acabase bien. Antes de exponer esto hay que
convertirlo en trabajo asíncrono con sondeo, como ya lo es el análisis.

### 1.4 Concurrencia de un solo trabajo

El análisis y la exportación usan guardas globales en memoria (`busy`,
`exporting`). Con varios usuarios, el segundo recibe `409`. Con varias réplicas
del contenedor, la guarda deja de funcionar porque no se comparte estado.

---

## 2. Configuración ya preparada

### Comandos

| Comando | Uso |
|---|---|
| `npm start` | Producción: `node src/server.js`, sin recarga ni dependencias de desarrollo |
| `npm run dev` | Desarrollo local con `--watch` |
| `npm test` | Suite completa (requiere FFmpeg) |
| `npm run doctor` | Diagnóstico del entorno y de los binarios |

No hay paso de build: el frontend son archivos estáticos servidos por el propio
Node, sin bundler ni dependencias de terceros.

### Variables de entorno

| Variable | Por defecto | Notas para deploy |
|---|---|---|
| `PORT` | `4321` | Configurable. Coolify suele inyectarlo. |
| `HOST` | `127.0.0.1` | En contenedor haría falta `0.0.0.0`, pero ver el bloqueador 1.1. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | autodetección | Necesarias si la imagen no trae `ffmpeg-static`. |
| `GEMINI_API_KEY` | vacío | **Secreto.** Sólo backend. Nunca en la imagen ni en el repo. |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Opcional. |
| `GEMINI_VIDEO_FPS` | `1` | Subirlo aumenta el coste proporcionalmente. |

La aplicación funciona entera sin `GEMINI_API_KEY`. Ver [COST_STRATEGY.md](COST_STRATEGY.md).

### Health check

`GET /api/health` responde `200` con `{"ok": true, ...}`. Sirve como health check
del orquestador. **Ojo:** hoy pasa la guarda global sólo si `HOST` no es
`127.0.0.1` o si la sonda corre dentro del contenedor.

### Requisitos de la imagen

- Node.js ≥ 18.17 (probado en 18.20.4 y 22.21.1).
- **FFmpeg y ffprobe con libx264 y aac.** Es el requisito más pesado: sin ellos
  no funciona nada. `ffmpeg-static` no incluye `ffprobe`, así que hay que
  instalar el paquete del sistema o fijar `FFPROBE_PATH`.
- CPU real: la exportación decodifica el material completo. Un contenedor con
  0,5 vCPU tardará mucho.

### Persistencia

Estas rutas **deben** ser volúmenes persistentes; si no, cada redeploy borra el
trabajo de la usuaria:

| Ruta | Contenido | Crece |
|---|---|---|
| `data/analyses/` | Copia del original + previsualización + análisis JSON | Mucho |
| `data/video-edits/` | Propuestas de edición (JSON) | Poco |
| `output/video-edits/` | MP4 exportados + metadata | Mucho |
| `.env` | Secretos | — |

**No hay política de limpieza automática.** Hoy se archiva a mano. En un servidor
esto llena el disco; hace falta retención antes de desplegar.

### Límites de subida

- Backend: 2 GiB por archivo, comprobado por `content-length` y también en el
  streaming (`413` si se excede). Duración máxima 4 horas.
- Frontend: valida tamaño y tipo antes de enviar.
- **Pendiente:** el proxy tiene su propio límite. En Nginx/Traefik hay que subir
  `client_max_body_size` a 2 GiB o el límite real será el del proxy, con un
  error mucho menos claro.

---

## 3. Notas para Coolify

No probado: es un plan, no un procedimiento verificado.

1. Aplicación tipo **Dockerfile** o **Nixpacks** con Node 22.
2. Instalar FFmpeg en la imagen (`apt-get install -y ffmpeg`, que trae ffprobe).
3. Comando de arranque `npm start`; puerto expuesto el de `PORT`.
4. Health check: `GET /api/health`.
5. Volúmenes persistentes para `data/` y `output/`.
6. `GEMINI_API_KEY` como secreto de Coolify, nunca en el repositorio.
7. Subir el límite de tamaño de petición del proxy a 2 GiB.
8. Aumentar el timeout del proxy, o resolver antes el bloqueador 1.3.

---

## 4. Orden recomendado antes de desplegar

1. Autenticación (bloqueador 1.2).
2. Convertir la exportación en trabajo asíncrono (1.3).
3. Decidir qué sustituye a las guardas de IP y de `Host` (1.1).
4. Política de retención y limpieza de `data/` y `output/`.
5. Cola de trabajos con estado compartido si va a haber más de un usuario (1.4).
6. Recién entonces, probar el despliegue en un entorno privado.
