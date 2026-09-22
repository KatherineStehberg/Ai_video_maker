/**
 * DE QUE TRATA UNA ESCENA: palabras para buscar su imagen.
 *
 * El banco de imagenes recibe estas palabras tal cual, asi que tienen que ser
 * las que un humano escribiria en el buscador: sustantivos concretos, no el
 * principio de la frase.
 *
 * COMO SE ELIGEN, SIN IA Y SIN DICCIONARIO
 *
 *   1. Fuera las palabras vacias: articulos, preposiciones, y los verbos y
 *      adverbios de uso general («tener», «conviene», «realmente»). Ninguno
 *      describe una imagen.
 *   2. Lo que va detras de un articulo casi siempre es un SUSTANTIVO en
 *      castellano («la luz», «el guion», «las escenas»). Es una pista sintactica
 *      barata y muy fiable, y puntua alto.
 *   3. Lo que distingue a ESTA escena del resto del guion puntua mas que lo que
 *      se repite en todas (tf-idf de toda la vida). Si el video entero habla de
 *      meditacion, «meditacion» no diferencia nada; «amanecer», si.
 *   4. Se devuelven dos o tres palabras, en el orden en que aparecen, porque un
 *      buscador de imagenes funciona mejor con pocas palabras concretas.
 *
 * Si no sobrevive ninguna palabra util, se devuelve cadena vacia: es mejor que
 * la interfaz diga que no hay sugerencia a que invente uUna busqueda absurda.
 */

/** Articulos y determinantes: lo que viene detras suele ser un sustantivo. */
const DETERMINANTES = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'del', 'al',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
  'su', 'sus', 'mi', 'mis', 'tu', 'tus', 'nuestro', 'nuestra', 'cada', 'tanto',
]);

/**
 * Palabras que nunca describen una imagen.
 *
 * Incluye los verbos mas frecuentes con sus formas habituales. Es una lista, no
 * una regla de sufijos, a proposito: en castellano muchos sustantivos acaban
 * como un infinitivo («lugar», «mujer», «amanecer»), y una regla automatica se
 * llevaria por delante justo las palabras mas visuales.
 */
const VACIAS = new Set([
  // ---- determinantes, preposiciones, conjunciones, pronombres ----
  'a', 'ante', 'bajo', 'con', 'contra', 'de', 'desde', 'durante', 'en', 'entre',
  'hacia', 'hasta', 'mediante', 'para', 'por', 'segun', 'según', 'sin', 'sobre', 'tras',
  'y', 'e', 'o', 'u', 'ni', 'pero', 'sino', 'aunque', 'porque', 'pues', 'que', 'qué',
  'si', 'sí', 'no', 'como', 'cómo', 'cuando', 'cuándo', 'donde', 'dónde', 'cual', 'cuál',
  'quien', 'quién', 'cuanto', 'cuánto', 'cuanta', 'cuantos', 'cuantas',
  'yo', 'tu', 'tú', 'el', 'él', 'ella', 'ello', 'nosotros', 'nosotras', 'vosotros',
  'ellos', 'ellas', 'usted', 'ustedes', 'me', 'te', 'se', 'nos', 'os', 'lo', 'le', 'les',
  'mi', 'mis', 'su', 'sus', 'tus', 'nuestro', 'nuestra', 'nuestros', 'nuestras',
  'la', 'las', 'los', 'un', 'una', 'unos', 'unas', 'del', 'al',
  'este', 'esta', 'esto', 'estos', 'estas', 'ese', 'esa', 'eso', 'esos', 'esas',
  'aquel', 'aquella', 'aquello', 'mismo', 'misma', 'mismos', 'mismas', 'otro', 'otra',
  'otros', 'otras', 'todo', 'toda', 'todos', 'todas', 'cada', 'algun', 'alguna',
  'alguno', 'algunos', 'algunas', 'ningun', 'ninguna', 'ninguno', 'mucho', 'mucha',
  'muchos', 'muchas', 'poco', 'poca', 'pocos', 'pocas', 'varios', 'varias', 'demas',
  'demás', 'tal', 'tales', 'tanto', 'tanta', 'tantos', 'tantas',
  // ---- adverbios y muletillas ----
  'aqui', 'aquí', 'alli', 'allí', 'ahi', 'ahí', 'ahora', 'antes', 'despues', 'después',
  'luego', 'siempre', 'nunca', 'jamas', 'jamás', 'ya', 'aun', 'aún', 'todavia', 'todavía',
  'muy', 'mas', 'más', 'menos', 'bien', 'mal', 'mejor', 'peor', 'casi', 'solo', 'sólo',
  'solamente', 'tambien', 'también', 'tampoco', 'quizas', 'quizás', 'acaso', 'asi', 'así',
  'entonces', 'ademas', 'además', 'incluso', 'apenas', 'bastante', 'demasiado', 'nada',
  'algo', 'alguien', 'nadie', 'cosa', 'cosas', 'vez', 'veces', 'parte', 'partes',
  'manera', 'forma', 'modo', 'tipo', 'clase', 'caso', 'punto', 'tema', 'ejemplo',
  'hondo', 'despacio', 'deprisa', 'pronto', 'tarde', 'temprano', 'claro', 'clara',
  'sola', 'solas', 'entero', 'entera', 'delante', 'detras', 'detrás', 'encima', 'debajo',
  'rato', 'ratos', 'momento', 'momentos', 'principio', 'final', 'finales',
  // ---- verbos de uso general y sus formas mas comunes ----
  'ser', 'soy', 'eres', 'es', 'somos', 'sois', 'son', 'era', 'eran', 'fue', 'fueron', 'sera', 'será', 'seran',
  'estar', 'estoy', 'esta', 'estamos', 'estan', 'están', 'estaba', 'estaban', 'estuvo', 'estara', 'estará',
  'haber', 'he', 'has', 'ha', 'hemos', 'han', 'habia', 'había', 'habra', 'habrá', 'hay',
  'tener', 'tengo', 'tienes', 'tiene', 'tenemos', 'tienen', 'tenia', 'tenía', 'tuvo', 'tendra', 'tendrá',
  'hacer', 'hago', 'haces', 'hace', 'hacemos', 'hacen', 'hacia', 'hacían', 'hizo', 'hara', 'hará', 'hecho',
  'poder', 'puedo', 'puedes', 'puede', 'podemos', 'pueden', 'podia', 'podía', 'pudo', 'podra', 'podrá',
  'querer', 'quiero', 'quieres', 'quiere', 'queremos', 'quieren', 'queria', 'quería', 'quiso',
  'deber', 'debo', 'debes', 'debe', 'debemos', 'deben', 'debia', 'debía',
  'saber', 'se', 'sabes', 'sabe', 'sabemos', 'saben', 'sabia', 'sabía', 'supo',
  'ver', 'veo', 'ves', 've', 'vemos', 'ven', 'veia', 'veía', 'vio', 'visto',
  'ir', 'voy', 'vas', 'va', 'vamos', 'van', 'iba', 'iban', 'fui', 'ido',
  'dar', 'doy', 'das', 'da', 'damos', 'dan', 'daba', 'dio', 'dado',
  'decir', 'digo', 'dices', 'dice', 'decimos', 'dicen', 'decia', 'decía', 'dijo', 'dicho',
  'llegar', 'llego', 'llega', 'llegamos', 'llegan', 'llegue', 'llegó', 'llegado',
  'pasar', 'paso', 'pasa', 'pasamos', 'pasan', 'pasado',
  'quedar', 'quedo', 'queda', 'quedan', 'quedado', 'quedar', 'quedará',
  'poner', 'pongo', 'pone', 'ponemos', 'ponen', 'puesto',
  'parecer', 'parece', 'parecen', 'parecia', 'parecía',
  'creer', 'creo', 'crees', 'cree', 'creemos', 'creen',
  'hablar', 'hablo', 'habla', 'hablamos', 'hablan', 'hablando',
  'llevar', 'llevo', 'lleva', 'llevamos', 'llevan',
  'dejar', 'dejo', 'deja', 'dejamos', 'dejan', 'dejado',
  'seguir', 'sigo', 'sigue', 'seguimos', 'siguen', 'siguiente',
  'encontrar', 'encuentro', 'encuentra', 'encontramos', 'encuentran',
  'empezar', 'empiezo', 'empieza', 'empezamos', 'empiezan', 'empezado',
  'comenzar', 'comienza', 'comenzamos', 'comienzan',
  'conseguir', 'consigo', 'consigue', 'conseguimos', 'consiguen', 'conseguido',
  'necesitar', 'necesito', 'necesita', 'necesitamos', 'necesitan',
  'permitir', 'permite', 'permiten', 'ayudar', 'ayuda', 'ayudan',
  'usar', 'uso', 'usa', 'usamos', 'usan', 'usando', 'utilizar', 'utiliza', 'utilizan',
  'mostrar', 'muestro', 'muestra', 'mostramos', 'muestran', 'mostrando',
  'convenir', 'conviene', 'convienen', 'tratar', 'trata', 'tratan',
  'existir', 'existe', 'existen', 'funcionar', 'funciona', 'funcionan', 'funcione',
  'servir', 'sirve', 'sirven', 'contar', 'cuenta', 'cuentan',
  'lograr', 'logra', 'logran', 'evitar', 'evita', 'evitan',
  'buscar', 'busca', 'buscamos', 'buscan', 'buscando',
  'propongas', 'proponer', 'propone', 'acercarte', 'acercar', 'acerca',
  'repasa', 'repasar', 'anota', 'anotar', 'respira', 'respirar', 'entre', 'entra',
  'grabar', 'graba', 'grabo', 'graban', 'grabamos', 'grabado',
  // cantidades: dicen cuanto, no de que
  'mayoria', 'mayoría', 'minoria', 'minoría', 'resto', 'total', 'mitad', 'doble',
  'numero', 'número', 'cantidad', 'monton', 'montón', 'serie', 'grupo', 'conjunto',
  // ---- ingles frecuente en guiones tecnicos ----
  'the', 'and', 'for', 'you', 'your', 'with', 'this', 'that', 'from', 'about', 'into',
]);

/** Sufijos que delatan una forma verbal o un adverbio, sin tocar sustantivos. */
const SUFIJOS_NO_VISUALES = [
  'mente',                                   // adverbios: realmente, rapidamente
  'ando', 'iendo', 'yendo',                  // gerundios: mirando, corriendo
  'aron', 'ieron', 'aste', 'iste',           // preteritos
  'aban', 'ian', 'ían', 'abamos', 'ábamos',  // imperfectos
  'aremos', 'eremos', 'iremos', 'arian', 'arían',
];

const sinTildes = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '');

const esVerbalOAdverbio = (palabra) => {
  const p = sinTildes(palabra);
  // Se exige que quede raiz suficiente: «mente» o «ando» sueltos no cuentan.
  return SUFIJOS_NO_VISUALES.some(suf => p.length > sinTildes(suf).length + 2 && p.endsWith(sinTildes(suf)));
};

/**
 * Parte el texto en palabras, anotando lo que hace falta para puntuarlas:
 * si abren frase (para no confundir mayuscula inicial con nombre propio) y
 * como venian escritas.
 */
function trocear(texto) {
  const fichas = [];
  // Se trabaja frase a frase porque la mayuscula solo delata un nombre propio
  // cuando NO abre la frase.
  for (const frase of String(texto || '').split(/[.!?¡¿:;\n]+/)) {
    const crudas = frase.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    crudas.forEach((crudo, i) => {
      fichas.push({ crudo, palabra: crudo.toLowerCase(), abreFrase: i === 0 });
    });
  }
  return fichas;
}

const soloPalabras = texto => trocear(texto).map(f => f.palabra);

/** ¿Vale esta palabra para buscar una imagen? */
function sirve(palabra) {
  // Tres letras es el minimo util, y hay palabras de tres muy visuales: luz,
  // sol, mar, paz, pan, rio. El filtro de largo antiguo (>3) las tiraba todas.
  if (palabra.length < 3) return false;
  if (VACIAS.has(palabra) || VACIAS.has(sinTildes(palabra))) return false;
  if (esVerbalOAdverbio(palabra)) return false;
  if (/^\d+$/.test(palabra)) return false;
  return true;
}

/**
 * Lo que suele seguir a un VERBO al principio de una frase: el complemento
 * empieza por articulo o preposicion. Sirve para distinguir «Dios camina» (un
 * sujeto) de «Repasa al final» (un verbo), que desde la mayuscula se ven igual.
 */
const ANTES_DE_COMPLEMENTO = new Set([
  ...DETERMINANTES,
  'de', 'en', 'a', 'con', 'por', 'para', 'sobre', 'desde', 'hasta', 'hacia',
  'entre', 'sin', 'tras', 'ante', 'bajo', 'durante', 'que', 'y', 'o',
]);

/**
 * Palabras clave de un texto, ordenadas por lo que APORTAN.
 *
 * @param {string} texto            la escena
 * @param {string[]} opts.contexto  las demas escenas, para saber que distingue a esta
 * @param {number} opts.max         cuantas palabras devolver
 */
export function palabrasClave(texto, { contexto = [], max = 3 } = {}) {
  const fichas = trocear(texto);
  if (!fichas.length) return [];

  // Cuantas escenas del guion usan cada palabra: lo que sale en todas no
  // distingue a ninguna.
  const enCuantas = new Map();
  for (const otra of contexto) {
    for (const p of new Set(soloPalabras(otra))) enCuantas.set(p, (enCuantas.get(p) || 0) + 1);
  }
  const total = Math.max(1, contexto.length);

  // Nombres propios del guion: los que aparecen en MAYUSCULA en mitad de alguna
  // frase, aqui o en cualquier otra escena. Hace falta mirarlo todo porque una
  // palabra que abre frase lleva mayuscula por posicion, no por ser nombre: sin
  // este repaso, «Dios camina contigo» se quedaba en «camino».
  const propios = new Set();
  for (const t of [texto, ...contexto]) {
    const fs_ = trocear(t);
    fs_.forEach((f, i) => {
      if (!/^\p{Lu}/u.test(f.crudo)) return;
      if (!f.abreFrase) { propios.add(f.palabra); return; }
      // Abriendo frase, la mayuscula no dice nada por si sola: la lleva
      // cualquier palabra. Pero un SUJETO suele ir seguido de su verbo, y un
      // VERBO suele ir seguido de su complemento, que empieza por articulo o
      // preposicion. «Dios camina contigo» -> nombre; «Repasa al final» -> no.
      const siguiente = fs_[i + 1]?.palabra;
      if (siguiente && !ANTES_DE_COMPLEMENTO.has(siguiente)) propios.add(f.palabra);
    });
  }

  const puntos = new Map();
  const posicion = new Map();
  const sustantivas = new Set();

  fichas.forEach((f, i) => {
    const p = f.palabra;
    if (!sirve(p)) return;
    if (!posicion.has(p)) posicion.set(p, i);

    let punto = 1;
    // Detras de un articulo: casi seguro un sustantivo.
    if (DETERMINANTES.has(fichas[i - 1]?.palabra)) { punto *= 1.8; sustantivas.add(p); }
    // Mayuscula en mitad de la frase: nombre propio (Dios, María, Chile). Son
    // de lo mas concreto que puede haber y casi nunca llevan articulo, asi que
    // sin esto se perdian.
    if (propios.has(p)) { punto *= 2; sustantivas.add(p); }
    // Lo propio de esta escena vale mas que lo que se repite en todo el guion.
    const df = enCuantas.get(p) || 0;
    punto *= 1 + Math.log(1 + (total - df) / total);
    // Las palabras muy cortas son mas ambiguas como busqueda.
    if (p.length >= 6) punto *= 1.15;

    puntos.set(p, (puntos.get(p) || 0) + punto);
  });

  // Si la frase trae sustantivos senalados (por articulo o por mayuscula), el
  // resto sobra: son los verbos que se cuelan («la mayoria GRABA con el
  // telefono» -> «telefono»).
  const candidatas = sustantivas.size
    ? [...puntos.entries()].filter(([p]) => sustantivas.has(p))
    : [...puntos.entries()];

  return candidatas
    .sort((a, b) => b[1] - a[1] || posicion.get(a[0]) - posicion.get(b[0]))
    .slice(0, max)
    .map(([p]) => p)
    // Se devuelven en el orden del texto: se leen mejor y forman sintagma.
    .sort((a, b) => posicion.get(a) - posicion.get(b));
}

/**
 * Sugerencia de busqueda para UNA escena, lista para el banco de imagenes.
 *
 * El tema del video se añade solo cuando la escena aporta poco por si sola: una
 * escena de dos palabras genericas busca mejor acompañada del asunto general.
 */
export function busquedaDeEscena(texto, { contexto = [], tema = '', max = 3 } = {}) {
  const clave = palabrasClave(texto, { contexto, max });
  if (clave.length >= 2) return clave.join(' ');

  const delTema = palabrasClave(tema, { max: 2 }).filter(p => !clave.includes(p));
  const juntas = [...clave, ...delTema].slice(0, max);
  // Sin nada que decir, no se inventa una busqueda.
  return juntas.join(' ');
}
