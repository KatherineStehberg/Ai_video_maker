/**
 * Formatos y estilos ofrecidos por el flujo de generación.
 *
 * Viven en su propio módulo, sin dependencias, porque los necesitan tanto
 * `jobs.js` como el contrato del Orquestador, y tenerlos en `jobs.js` obligaba
 * a un ciclo de importación entre los dos.
 */

/** Formatos de este flujo (el backend de edición admite alguno más). */
export const FORMATS = ['9:16', '16:9', '1:1'];

export const STYLES = ['cinematográfico', 'documental', 'dinámico', 'minimalista', 'corporativo'];
