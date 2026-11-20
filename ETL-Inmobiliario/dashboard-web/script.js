/* =========================================================================
   Exploración del Mercado Inmobiliario: King County, WA
   Lógica de la página del pitch: carga de datos, filtros, KPI, gráficos,
   simulador de precio, validación estadística y modo presentación.
   Todos los valores salen de datos.json, el artefacto publicado junto a la web.
   ========================================================================= */
'use strict';

// ---------------------------------------------------------------------------
// Configuración general
// ---------------------------------------------------------------------------
const LOCALE = 'es-CO';

// Paleta del informe de Power BI
const PALETA = {
  principal: '#1F4E79',
  azul: '#2E86AB',
  naranja: '#F18F01',
  rojo: '#C73E1D',
  verde: '#3B8B5A',
  violeta: '#6C4F9E',
  gris: '#9AA5B1',
};

// Colores de los rangos de precio, de económico (verde) a lujo (rojo)
const COLORES_RANGO = [PALETA.verde, PALETA.azul, PALETA.violeta, PALETA.naranja, PALETA.rojo];

// Nombres legibles de las variables y factores que vienen del ETL
const NOMBRES = {
  sqft_living_m2: 'Superficie (m²)',
  sqft_lot_m2: 'Terreno (m²)',
  sqft_above: 'Superficie sobre rasante',
  sqft_living15: 'Superficie de los vecinos',
  sqft_basement: 'Superficie del sótano',
  sqft_lot15: 'Terreno de los vecinos',
  grade: 'Calidad (grade)',
  bathrooms: 'Baños',
  bedrooms: 'Habitaciones',
  view: 'Vista',
  lat: 'Latitud',
  long: 'Longitud',
  waterfront: 'Frente al agua',
  floors: 'Plantas',
  tiene_sotano: 'Tiene sótano',
  renovada: 'Renovada',
  yr_renovated: 'Año de renovación',
  yr_built: 'Año de construcción',
  condition: 'Condición',
  anio_venta: 'Año de venta',
  mes_venta: 'Mes de venta',
  n_ventas: 'Veces vendida',
  antiguedad: 'Antigüedad',
  categoria_calidad: 'Categoría de calidad',
  ciudad: 'Ciudad',
  grupo_banios: 'Grupo de baños',
  grupo_habitaciones: 'Grupo de habitaciones',
  tipo_vivienda: 'Tipo de vivienda',
  rango_antiguedad: 'Rango de antigüedad',
  frente_agua: 'Frente al agua',
  interaccion: 'Interacción baños × habitaciones',
  residuos: 'Residuos',
};

// Controles del simulador: id del control y variable del modelo lineal
const CONTROLES_SIMULADOR = [
  { id: 'sim-m2', variable: 'sqft_living_m2', formato: v => `${num(v)} m²` },
  { id: 'sim-banios', variable: 'bathrooms', formato: v => numFlexible(v, 2) },
  { id: 'sim-habitaciones', variable: 'bedrooms', formato: v => num(v) },
  { id: 'sim-calidad', variable: 'grade', formato: v => num(v) },
];

// Filtros de la barra superior: id del select y columna de la venta
const FILTROS = [
  { id: 'filtro-anio', campo: 'anio', nombre: 'Año' },
  { id: 'filtro-ciudad', campo: 'ciudad', nombre: 'Ciudad' },
  { id: 'filtro-rango', campo: 'rango_precio', nombre: 'Rango', etiqueta: v => etiquetaRango(v) },
  { id: 'filtro-tipo', campo: 'tipo_vivienda', nombre: 'Tipo' },
  { id: 'filtro-agua', campo: 'waterfront', nombre: 'Frente al agua', etiqueta: v => (v === 1 ? 'Sí' : 'No') },
];

// Límites de la muestra del gráfico de superficie vs. precio
const MAX_PUNTOS_SUPERFICIE = 3000;

// Estado de la aplicación
const estado = {
  datos: null,          // contenido completo de datos.json
  todas: [],            // todas las ventas, ya decodificadas
  filtradas: [],        // ventas que pasan los filtros
  graficos: {},         // instancias de Chart.js, se crean una sola vez
  ordenes: {},          // orden lógico de las categorías
  periodoIncompleto: null,
  extensionMapa: null,
  kpiVisible: false,
  reducirMovimiento: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
};

// ---------------------------------------------------------------------------
// Formato de números y fechas (es-CO: miles con punto, decimales con coma)
// ---------------------------------------------------------------------------
const cacheFormatos = {};

/** Devuelve (y guarda) un Intl.NumberFormat con la cantidad de decimales pedida. */
function formateador(minDec, maxDec = minDec) {
  const clave = `${minDec}-${maxDec}`;
  if (!cacheFormatos[clave]) {
    cacheFormatos[clave] = new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: minDec,
      maximumFractionDigits: maxDec,
      useGrouping: 'always',
    });
  }
  return cacheFormatos[clave];
}

/** Número con una cantidad fija de decimales. */
function num(valor, decimales = 0) {
  return formateador(decimales).format(valor);
}

/** Número con hasta `maxDec` decimales (sin ceros sobrantes). */
function numFlexible(valor, maxDec) {
  return formateador(0, maxDec).format(valor);
}

/** Precio en dólares, sin decimales. */
function usd(valor) {
  return `USD ${num(valor)}`;
}

/** Precio abreviado: USD 2,19 M o USD 542 mil. */
function usdCorto(valor) {
  const abs = Math.abs(valor);
  if (abs >= 1e6) return `USD ${num(valor / 1e6, 2)} M`;
  if (abs >= 1e3) return `USD ${num(valor / 1e3)} mil`;
  return usd(valor);
}

/** Porcentaje a partir de una fracción (0,25 → 25,0 %). */
function pct(fraccion, decimales = 1) {
  return `${num(fraccion * 100, decimales)} %`;
}

/** Porcentaje con signo (+6,2 % / −3,1 %). */
function pctConSigno(fraccion, decimales = 1) {
  const signo = fraccion > 0 ? '+' : fraccion < 0 ? '−' : '';
  return `${signo}${pct(Math.abs(fraccion), decimales)}`;
}

/** p-valor en notación científica con superíndice. */
function cientifico(p) {
  if (p === null || p === undefined || Number.isNaN(p)) return '—';
  // Un p-valor 0 significa que es menor que el mínimo representable en coma flotante
  if (p === 0) return '&lt; 1 × 10<sup>−300</sup>';
  const [mantisa, exponente] = p.toExponential(2).split('e');
  return `${mantisa.replace('.', ',')} × 10<sup>${exponente.replace('+', '').replace('-', '−')}</sup>`;
}

/** Convierte 'AAAA-MM-DD' en una fecha local (sin desfase de zona horaria). */
function parsearFecha(texto) {
  const [a, m, d] = texto.split('-').map(Number);
  return new Date(a, m - 1, d);
}

const formatoFechaLarga = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
const formatoMes = new Intl.DateTimeFormat(LOCALE, { month: 'short' });
const formatoMesLargo = new Intl.DateTimeFormat(LOCALE, { month: 'long' });

/** '2014-05' → 'may 2014'. */
function etiquetaPeriodo(periodo) {
  const [a, m] = periodo.split('-').map(Number);
  return `${formatoMes.format(new Date(a, m - 1, 1)).replace('.', '')} ${a}`;
}

/** '2014-05' → 'mayo de 2014'. */
function periodoLargo(periodo) {
  const [a, m] = periodo.split('-').map(Number);
  return `${formatoMesLargo.format(new Date(a, m - 1, 1))} de ${a}`;
}

/** Quita el prefijo de orden de los rangos: '3. Medio-alto (500K-750K)' → 'Medio-alto (500K-750K)'. */
function etiquetaRango(rango) {
  return String(rango).replace(/^\d+\.\s*/, '');
}

/** Nombre legible de una variable o factor. */
function nombre(variable) {
  return NOMBRES[variable] || variable;
}

/** Escapa texto antes de insertarlo como HTML. */
function esc(texto) {
  return String(texto).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Une una lista en lenguaje natural: 'a, b y c'. */
function listaNatural(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/** Parte una etiqueta larga en líneas ('Bellevue Centro / Clyde Hill' → ['Bellevue Centro /', 'Clyde Hill']). */
function partirEtiqueta(texto) {
  const partes = String(texto).split(' / ');
  return partes.length > 1 ? partes.map((p, i) => (i < partes.length - 1 ? `${p} /` : p)) : texto;
}

/** Posición de la leyenda de la dona según el ancho disponible. */
function posicionLeyenda(ancho) {
  return ancho < 560 ? 'bottom' : 'right';
}

/** Escribe una frase de interpretación (HTML) en el elemento indicado. */
function escribir(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Cálculos estadísticos
// ---------------------------------------------------------------------------

/** Totales de un conjunto de ventas. */
function resumir(filas) {
  let suma = 0;
  let sumaM2 = 0;
  for (const v of filas) {
    suma += v.price;
    sumaM2 += v.sqft_living_m2;
  }
  const n = filas.length;
  return {
    n,
    suma,
    sumaM2,
    promedio: n ? suma / n : NaN,
    precioM2: sumaM2 ? suma / sumaM2 : NaN,   // igual que la medida DAX: SUM(price) / SUM(m²)
    m2Promedio: n ? sumaM2 / n : NaN,
  };
}

/** Agrupa las ventas por una columna (o función) y resume cada grupo. */
function agrupar(filas, clave) {
  const obtener = typeof clave === 'function' ? clave : v => v[clave];
  const grupos = new Map();
  for (const v of filas) {
    const k = obtener(v);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(v);
  }
  return [...grupos.entries()].map(([k, lista]) => ({ clave: k, filas: lista, ...resumir(lista) }));
}

/** Ordena grupos según el orden lógico de una lista de categorías. */
function ordenarSegun(grupos, orden) {
  return grupos.sort((a, b) => orden.indexOf(a.clave) - orden.indexOf(b.clave));
}

/** Mediana de una lista de números. */
function mediana(valores) {
  if (!valores.length) return NaN;
  const ordenados = Float64Array.from(valores).sort();
  const medio = ordenados.length >> 1;
  return ordenados.length % 2 ? ordenados[medio] : (ordenados[medio - 1] + ordenados[medio]) / 2;
}

/** Correlación de Pearson entre dos listas. */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return NaN;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n;
  my /= n;
  let cov = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    sx += dx * dx;
    sy += dy * dy;
  }
  return sx && sy ? cov / Math.sqrt(sx * sy) : NaN;
}

/** Recta de mínimos cuadrados y = intercepto + pendiente · x. */
function minimosCuadrados(xs, ys) {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const pendiente = sxx ? sxy / sxx : 0;
  return { pendiente, intercepto: my - pendiente * mx };
}

/** Muestra uniforme y determinista (siempre los mismos puntos para el mismo filtro). */
function muestraUniforme(lista, maximo) {
  if (lista.length <= maximo) return lista;
  const paso = lista.length / maximo;
  return Array.from({ length: maximo }, (_, i) => lista[Math.floor(i * paso)]);
}

/** Prima por frente al agua: promedio con frente / promedio sin frente − 1. */
function primaFrenteAgua(filas) {
  const con = resumir(filas.filter(v => v.waterfront === 1));
  const sin = resumir(filas.filter(v => v.waterfront === 0));
  const prima = con.n && sin.n ? con.promedio / sin.promedio - 1 : NaN;
  return { con, sin, prima };
}

/** Variación del precio por m² entre el primer mes y el último mes completo. */
function variacionPrecioM2(filas) {
  const meses = agrupar(filas, 'periodo').sort((a, b) => a.clave.localeCompare(b.clave));
  const completos = meses.filter(m => m.clave !== estado.periodoIncompleto);
  if (completos.length < 2) return { meses, primero: null, ultimo: null, cambio: NaN };
  const primero = completos[0];
  const ultimo = completos[completos.length - 1];
  return { meses, primero, ultimo, cambio: ultimo.precioM2 / primero.precioM2 - 1 };
}

/** Busca una fila de resultados_anova por factor. */
function factorAnova(factor) {
  return estado.datos.resultados_anova.find(f => f.factor === factor);
}

/** Correlación global (tabla correlaciones) de una variable. */
function correlacionGlobal(variable) {
  const fila = estado.datos.correlaciones.find(c => c.variable === variable);
  return fila ? fila.correlacion_con_precio : NaN;
}

/** Métricas de los modelos ordenadas de mejor a peor R². */
function modelosOrdenados() {
  return [...estado.datos.metricas_modelo].sort((a, b) => b.r2 - a.r2);
}

/** Coeficientes del modelo lineal como objeto { variable: coeficiente }. */
function coeficientes() {
  return Object.fromEntries(estado.datos.coeficientes_modelo.map(c => [c.variable, c.coeficiente]));
}

// ---------------------------------------------------------------------------
// Carga y preparación de datos
// ---------------------------------------------------------------------------

/** Lee datos.json y decodifica las ventas (columnas + filas + catálogos). */
async function cargarDatos() {
  const respuesta = await fetch('datos.json');
  if (!respuesta.ok) throw new Error(`No se pudo leer datos.json (HTTP ${respuesta.status}).`);
  const datos = await respuesta.json();
  const { columnas, catalogos, filas } = datos.ventas;

  estado.datos = datos;
  estado.todas = filas.map(fila => {
    const venta = {};
    columnas.forEach((col, i) => {
      venta[col] = catalogos[col] ? catalogos[col][fila[i]] : fila[i];
    });
    const ubicacion = datos.ubicacion[venta.zipcode] || {};
    venta.ciudad = ubicacion.ciudad || 'Sin dato';
    venta.barrio = ubicacion.barrio || 'Sin dato';
    return venta;
  });
  estado.filtradas = estado.todas;
  prepararOrdenes();
}

/** Calcula el orden lógico de las categorías y otros valores de referencia. */
function prepararOrdenes() {
  const { catalogos } = estado.datos.ventas;
  const todas = estado.todas;

  // Las categorías de calidad se ordenan por su grade promedio (Económica → Lujo)
  const gradoPromedio = agrupar(todas, 'categoria_calidad').map(g => ({
    clave: g.clave,
    grado: g.filas.reduce((s, v) => s + v.grade, 0) / g.n,
  }));
  estado.ordenes = {
    rango_precio: catalogos.rango_precio,
    grupo_banios: catalogos.grupo_banios,
    grupo_habitaciones: catalogos.grupo_habitaciones,
    decada_construccion: catalogos.decada_construccion,
    categoria_calidad: gradoPromedio.sort((a, b) => a.grado - b.grado).map(g => g.clave),
  };

  // Mes incompleto: el de la fecha máxima, si no llega al último día del mes
  const fechaMax = parsearFecha(estado.datos.metadatos.fecha_max);
  const ultimoDia = new Date(fechaMax.getFullYear(), fechaMax.getMonth() + 1, 0).getDate();
  estado.periodoIncompleto = fechaMax.getDate() < ultimoDia ? estado.datos.metadatos.fecha_max.slice(0, 7) : null;

  // Extensión fija del mapa, para que no cambie de escala al filtrar
  const lats = todas.map(v => v.lat);
  const longs = todas.map(v => v.long);
  const margen = 0.02;
  estado.extensionMapa = {
    xMin: Math.min(...longs) - margen, xMax: Math.max(...longs) + margen,
    yMin: Math.min(...lats) - margen, yMax: Math.max(...lats) + margen,
  };
}

// ---------------------------------------------------------------------------
// Filtros
// ---------------------------------------------------------------------------

/** Llena cada filtro con los valores que existen en los datos. */
function prepararFiltros() {
  for (const filtro of FILTROS) {
    const select = document.getElementById(filtro.id);
    let valores = [...new Set(estado.todas.map(v => v[filtro.campo]))];
    if (filtro.campo === 'waterfront') valores.sort((a, b) => b - a);           // Sí, No
    else if (typeof valores[0] === 'number') valores.sort((a, b) => a - b);
    else valores.sort((a, b) => String(a).localeCompare(String(b), 'es'));

    for (const valor of valores) {
      const opcion = document.createElement('option');
      opcion.value = String(valor);
      opcion.textContent = filtro.etiqueta ? filtro.etiqueta(valor) : valor;
      select.appendChild(opcion);
    }
    select.addEventListener('change', aplicarFiltros);
  }
  document.getElementById('limpiar-filtros').addEventListener('click', limpiarFiltros);
}

/** Filtra las ventas con los valores elegidos y actualiza toda la página. */
function aplicarFiltros() {
  const activos = FILTROS
    .map(f => ({ ...f, select: document.getElementById(f.id) }))
    .filter(f => {
      f.select.classList.toggle('activo', f.select.value !== '');
      return f.select.value !== '';
    });

  estado.filtradas = activos.length
    ? estado.todas.filter(v => activos.every(f => String(v[f.campo]) === f.select.value))
    : estado.todas;

  actualizarResumenFiltros(activos);
  actualizarTodo();
}

/** Vuelve todos los filtros a "Todos". */
function limpiarFiltros() {
  for (const f of FILTROS) document.getElementById(f.id).value = '';
  aplicarFiltros();
}

/** Texto de la barra: cuántas ventas se muestran y qué filtros están activos. */
function actualizarResumenFiltros(activos) {
  const total = estado.todas.length;
  const n = estado.filtradas.length;
  let texto = activos.length
    ? `Mostrando <strong>${num(n)}</strong> de ${num(total)} ventas · ` +
      activos.map(f => `${esc(f.nombre)}: ${esc(f.select.options[f.select.selectedIndex].text)}`).join(' · ')
    : `Mostrando las <strong>${num(total)}</strong> ventas (sin filtros)`;
  if (n === 0) texto = '<strong>Sin datos para esta combinación</strong>';
  document.getElementById('filtros-resumen').innerHTML = texto;
  document.getElementById('filtros-boton').textContent = activos.length ? `Filtros (${activos.length})` : 'Filtros';
}

// ---------------------------------------------------------------------------
// Actualización general
// ---------------------------------------------------------------------------

/** Recalcula los KPI y todos los gráficos que dependen de las ventas filtradas. */
function actualizarTodo() {
  const filas = estado.filtradas;
  const vacio = filas.length === 0;
  document.body.classList.toggle('sin-datos', vacio);
  calcularKPI(filas);
  if (vacio) return;

  graficoPrecioM2(filas);
  graficoTipos(filas);
  graficoMapa(filas);
  graficoBarrios(filas);
  graficoBaniosHabitaciones(filas);
  graficoConstruccion(filas);
  graficoSuperficie(filas);
  graficoAgua(filas);
  graficoSegmentos(filas);
}

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------

/** Anima un número desde su valor anterior hasta el nuevo. */
function animarNumero(id, destino, formato) {
  const el = document.getElementById(id);
  cancelAnimationFrame(el._animacion);
  if (!Number.isFinite(destino)) {
    el.textContent = '—';
    el.dataset.valor = '0';
    return;
  }
  const inicio = Number(el.dataset.valor) || 0;
  el.dataset.valor = String(destino);
  if (estado.reducirMovimiento) {
    el.textContent = formato(destino);
    return;
  }
  const duracion = 600;
  const t0 = performance.now();
  const paso = ahora => {
    const t = Math.min(1, (ahora - t0) / duracion);
    const suavizado = 1 - (1 - t) ** 3;
    el.textContent = formato(inicio + (destino - inicio) * suavizado);
    if (t < 1) el._animacion = requestAnimationFrame(paso);
  };
  el._animacion = requestAnimationFrame(paso);
}

/** Calcula las seis tarjetas de indicadores sobre las ventas filtradas. */
function calcularKPI(filas) {
  // Los contadores arrancan cuando la sección aparece en pantalla
  if (!estado.kpiVisible) return;

  const r = resumir(filas);
  const total = estado.todas.length;

  animarNumero('kpi-total', r.n ? r.suma : NaN, v => `USD ${num(v / 1e6)} M`);
  escribir('kpi-total-detalle', r.n ? 'Suma del precio de todas las ventas' : 'Sin datos para esta combinación');

  animarNumero('kpi-ventas', r.n ? r.n : NaN, v => num(Math.round(v)));
  escribir('kpi-ventas-detalle', r.n ? `${pct(r.n / total)} de las ${num(total)} ventas limpias` : 'Sin datos para esta combinación');

  animarNumero('kpi-promedio', r.promedio, v => usd(v));
  escribir('kpi-mediana', r.n ? `Mediana: <strong>${usd(mediana(filas.map(v => v.price)))}</strong>` : '');

  animarNumero('kpi-m2', r.precioM2, v => usd(v));
  escribir('kpi-m2-detalle', r.n ? `Superficie promedio: ${num(r.m2Promedio, 1)} m²` : '');

  const agua = primaFrenteAgua(filas);
  animarNumero('kpi-prima', agua.prima * 100, v => pctConSigno(v / 100));
  escribir('kpi-prima-detalle', Number.isFinite(agua.prima)
    ? `${usdCorto(agua.con.promedio)} con frente al agua frente a ${usdCorto(agua.sin.promedio)} sin frente`
    : 'Se necesitan ventas con y sin frente al agua');

  const variacion = variacionPrecioM2(filas);
  animarNumero('kpi-variacion', variacion.cambio * 100, v => pctConSigno(v / 100));
  escribir('kpi-variacion-detalle', variacion.primero
    ? `${etiquetaPeriodo(variacion.primero.clave)}: ${usd(variacion.primero.precioM2)} → ${etiquetaPeriodo(variacion.ultimo.clave)}: ${usd(variacion.ultimo.precioM2)}`
    : 'Se necesitan al menos dos meses completos');
}

/** Nota sobre el mes incompleto, tomada de los metadatos. */
function notaMesIncompleto() {
  if (!estado.periodoIncompleto) return;
  const fechaMax = parsearFecha(estado.datos.metadatos.fecha_max);
  escribir('nota-mes-incompleto',
    `Nota: ${periodoLargo(estado.periodoIncompleto)} está incompleto (los datos llegan hasta el día ${fechaMax.getDate()}), ` +
    'por eso la variación compara el primer mes con el último mes completo.');
}

// ---------------------------------------------------------------------------
// Utilidades de Chart.js
// ---------------------------------------------------------------------------

/** Ajustes globales de Chart.js para que se lea bien desde un proyector. */
function configurarChart() {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  // Letra más grande en pantallas anchas (proyector) y más chica en el celular
  Chart.defaults.font.size = window.innerWidth >= 1024 ? 16 : 13;
  Chart.defaults.color = '#3D4A5C';
  Chart.defaults.locale = LOCALE;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.borderColor = 'rgba(31, 78, 121, 0.08)';
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(20, 35, 55, 0.92)';
  Chart.defaults.plugins.tooltip.titleFont = { weight: '600', size: 15 };
  Chart.defaults.plugins.tooltip.bodyFont = { size: 15 };
  // Animaciones cortas para no hacer esperar durante la presentación
  Chart.defaults.animation.duration = 450;
  if (estado.reducirMovimiento) Chart.defaults.animation = false;
}

/** Crea el gráfico la primera vez y después devuelve la misma instancia. */
function obtenerGrafico(id, crearConfiguracion) {
  if (!estado.graficos[id]) {
    estado.graficos[id] = new Chart(document.getElementById(id), crearConfiguracion());
  }
  return estado.graficos[id];
}

/** Configuración de un gráfico de barras de una serie. */
function configBarras({ horizontal = false, serie, color = PALETA.principal, formato = usdCorto, formatoTooltip = usd, extraTooltip = null }) {
  const ejeValor = horizontal ? 'x' : 'y';
  const ejeCategoria = horizontal ? 'y' : 'x';
  return {
    type: 'bar',
    data: { labels: [], datasets: [{ label: serie, data: [], backgroundColor: color, borderRadius: 4, maxBarThickness: 56 }] },
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => `${c.dataset.label}: ${formatoTooltip(c.parsed[ejeValor])}`,
            afterLabel: extraTooltip || undefined,
          },
        },
      },
      scales: {
        [ejeValor]: { beginAtZero: true, ticks: { callback: v => formato(v) } },
        [ejeCategoria]: { grid: { display: false }, ticks: { autoSkip: false } },
      },
    },
  };
}

/** Asigna etiquetas y valores a un gráfico de una serie y lo redibuja. */
function actualizarSerie(grafico, etiquetas, valores, colores) {
  grafico.data.labels = etiquetas;
  grafico.data.datasets[0].data = valores;
  if (colores) grafico.data.datasets[0].backgroundColor = colores;
  grafico.update();
}

/** Color con transparencia a partir de un hexadecimal. */
function conAlfa(hex, alfa) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
}

// ---------------------------------------------------------------------------
// Requerimiento 1: precio por m² por ciudad y por mes
// ---------------------------------------------------------------------------
function graficoPrecioM2(filas) {
  // Barras: precio por m² por ciudad, de mayor a menor
  const ciudades = agrupar(filas, 'ciudad').sort((a, b) => b.precioM2 - a.precioM2);
  const barras = obtenerGrafico('grafico-ciudad-m2', () => configBarras({
    horizontal: true,
    serie: 'Precio por m²',
    formato: v => usd(v),
    extraTooltip: c => `${num(estado.detalleCiudades[c.dataIndex].n)} ventas`,
  }));
  estado.detalleCiudades = ciudades;
  actualizarSerie(barras, ciudades.map(c => c.clave), ciudades.map(c => c.precioM2),
    ciudades.map((_, i) => (i === 0 ? PALETA.naranja : PALETA.principal)));

  const mayor = ciudades[0];
  const menor = ciudades[ciudades.length - 1];
  escribir('frase-ciudad-m2', ciudades.length > 1
    ? `<strong>${esc(mayor.clave)}</strong> tiene el m² más caro (${usd(mayor.precioM2)}/m²), ` +
      `${num(mayor.precioM2 / menor.precioM2, 1)} veces el de <strong>${esc(menor.clave)}</strong>, el más barato (${usd(menor.precioM2)}/m²).`
    : `En la selección solo hay ventas en <strong>${esc(mayor.clave)}</strong>: ${usd(mayor.precioM2)}/m².`);

  // Línea: precio por m² por mes; el tramo del mes incompleto va punteado
  const variacion = variacionPrecioM2(filas);
  const periodos = variacion.meses.map(m => m.clave);
  const linea = obtenerGrafico('grafico-mes-m2', () => ({
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Precio por m²',
        data: [],
        borderColor: PALETA.principal,
        backgroundColor: conAlfa(PALETA.principal, 0.1),
        fill: true,
        tension: 0.3,
        pointRadius: 5,
        pointHoverRadius: 7,
        segment: { borderDash: c => (estado.periodosLinea[c.p1DataIndex] === estado.periodoIncompleto ? [6, 5] : undefined) },
      }],
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => `Precio por m²: ${usd(c.parsed.y)}`,
            afterLabel: c => (estado.periodosLinea[c.dataIndex] === estado.periodoIncompleto ? 'Mes incompleto' : ''),
          },
        },
      },
      scales: {
        y: { ticks: { callback: v => usd(v) } },
        x: { grid: { display: false } },
      },
    },
  }));
  estado.periodosLinea = periodos;
  linea.data.datasets[0].pointBackgroundColor = periodos.map(p => (p === estado.periodoIncompleto ? '#fff' : PALETA.principal));
  actualizarSerie(linea, periodos.map(etiquetaPeriodo), variacion.meses.map(m => m.precioM2));

  let frase = variacion.primero
    ? `Entre ${etiquetaPeriodo(variacion.primero.clave)} y ${etiquetaPeriodo(variacion.ultimo.clave)} el precio por m² ` +
      `${variacion.cambio >= 0 ? 'subió' : 'bajó'} <strong>${pct(Math.abs(variacion.cambio))}</strong> ` +
      `(de ${usd(variacion.primero.precioM2)} a ${usd(variacion.ultimo.precioM2)}).`
    : 'Hacen falta al menos dos meses completos para medir la variación.';
  if (periodos.includes(estado.periodoIncompleto)) frase += ` El tramo punteado es ${etiquetaPeriodo(estado.periodoIncompleto)}, un mes incompleto.`;
  escribir('frase-mes-m2', frase);
}

// ---------------------------------------------------------------------------
// Requerimiento 2: comparativa entre tipos de vivienda
// ---------------------------------------------------------------------------
function graficoTipos(filas) {
  const tipos = agrupar(filas, 'tipo_vivienda').sort((a, b) => b.promedio - a.promedio);
  const grafico = obtenerGrafico('grafico-tipos', () => ({
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        { label: 'Precio promedio', data: [], backgroundColor: PALETA.principal, borderRadius: 4, yAxisID: 'y', maxBarThickness: 64 },
        { label: 'Precio por m²', data: [], backgroundColor: PALETA.naranja, borderRadius: 4, yAxisID: 'y1', maxBarThickness: 64 },
      ],
    },
    options: {
      plugins: {
        legend: { position: 'top' },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${usd(c.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, position: 'left', title: { display: true, text: 'Precio promedio' }, ticks: { callback: v => usdCorto(v) } },
        y1: { beginAtZero: true, position: 'right', title: { display: true, text: 'Precio por m²' }, grid: { drawOnChartArea: false }, ticks: { callback: v => usd(v) } },
      },
    },
  }));
  grafico.data.labels = tipos.map(t => t.clave);
  grafico.data.datasets[0].data = tipos.map(t => t.promedio);
  grafico.data.datasets[1].data = tipos.map(t => t.precioM2);
  grafico.update();

  const caro = tipos[0];
  const barato = tipos[tipos.length - 1];
  const lider = [...tipos].sort((a, b) => b.precioM2 - a.precioM2)[0];
  escribir('frase-tipos', tipos.length > 1
    ? `Las viviendas de tipo <strong>${esc(caro.clave)}</strong> son las más caras, con ${usdCorto(caro.promedio)} de promedio: ` +
      `${num(caro.promedio / barato.promedio, 1)} veces el tipo <strong>${esc(barato.clave)}</strong> (${usdCorto(barato.promedio)}). ` +
      `En precio por m² lidera <strong>${esc(lider.clave)}</strong> (${usd(lider.precioM2)}/m²).`
    : `En la selección solo hay viviendas de tipo <strong>${esc(caro.clave)}</strong>: ${usdCorto(caro.promedio)} de promedio y ${usd(caro.precioM2)}/m².`);
}

// ---------------------------------------------------------------------------
// Requerimiento 3: mapa de precios (dispersión longitud / latitud)
// ---------------------------------------------------------------------------
function graficoMapa(filas) {
  const rangos = estado.ordenes.rango_precio;
  const ext = estado.extensionMapa;
  const grafico = obtenerGrafico('grafico-mapa', () => ({
    type: 'scatter',
    data: {
      datasets: rangos.map((r, i) => ({
        label: etiquetaRango(r),
        data: [],
        backgroundColor: conAlfa(COLORES_RANGO[i % COLORES_RANGO.length], 0.65),
        borderWidth: 0,
        pointRadius: 2,
        pointHoverRadius: 5,
      })),
    },
    options: {
      animation: false,
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            title: () => '',
            label: c => `${c.raw.barrio} (${c.raw.ciudad}): ${usd(c.raw.precio)}`,
          },
        },
      },
      scales: {
        x: { min: ext.xMin, max: ext.xMax, title: { display: true, text: 'Longitud' }, ticks: { callback: v => num(v, 2) } },
        y: { min: ext.yMin, max: ext.yMax, title: { display: true, text: 'Latitud' }, ticks: { callback: v => num(v, 2) } },
      },
    },
  }));
  grafico.data.datasets.forEach((dataset, i) => {
    dataset.data = filas
      .filter(v => v.rango_precio === rangos[i])
      .map(v => ({ x: v.long, y: v.lat, barrio: v.barrio, ciudad: v.ciudad, precio: v.price }));
  });
  grafico.update();

  // Frase: dónde se concentran las ventas del rango más alto y cuál fue la venta más cara
  const rangoAlto = rangos[rangos.length - 1];
  const altas = filas.filter(v => v.rango_precio === rangoAlto);
  const maxima = filas.reduce((a, b) => (b.price > a.price ? b : a));
  let frase = '';
  if (altas.length) {
    const top = agrupar(altas, 'ciudad').sort((a, b) => b.n - a.n).slice(0, 3);
    const participacion = top.reduce((s, c) => s + c.n, 0) / altas.length;
    frase = `El <strong>${pct(participacion)}</strong> de las ${num(altas.length)} ventas «${esc(etiquetaRango(rangoAlto))}» ` +
      `se concentra en ${listaNatural(top.map(c => `<strong>${esc(c.clave)}</strong>`))}. `;
  }
  frase += `La venta más cara de la selección está en ${esc(maxima.barrio)} (${esc(maxima.ciudad)}): ${usdCorto(maxima.price)}.`;
  escribir('frase-mapa', frase);
}

// ---------------------------------------------------------------------------
// Requerimiento 4: top 10 barrios más costosos
// ---------------------------------------------------------------------------
function graficoBarrios(filas) {
  const general = resumir(filas);
  const barrios = agrupar(filas, v => `${v.barrio}|${v.ciudad}`)
    .map(g => ({ ...g, barrio: g.filas[0].barrio, ciudad: g.filas[0].ciudad }))
    .sort((a, b) => b.promedio - a.promedio)
    .slice(0, 10);
  const grafico = obtenerGrafico('grafico-barrios', () => configBarras({
    horizontal: true,
    serie: 'Precio promedio',
    extraTooltip: c => `${estado.detalleBarrios[c.dataIndex].ciudad} · ${num(estado.detalleBarrios[c.dataIndex].n)} ventas`,
  }));
  estado.detalleBarrios = barrios;
  actualizarSerie(grafico, barrios.map(b => partirEtiqueta(b.barrio)), barrios.map(b => b.promedio),
    barrios.map((_, i) => (i === 0 ? PALETA.naranja : PALETA.principal)));

  const primero = barrios[0];
  escribir('frase-barrios',
    `El barrio más caro es <strong>${esc(primero.barrio)}</strong>${primero.barrio === primero.ciudad ? '' : ` (${esc(primero.ciudad)})`}, con un promedio de ` +
    `<strong>${usdCorto(primero.promedio)}</strong>: ${num(primero.promedio / general.promedio, 1)} veces el promedio de la selección ` +
    `(${usdCorto(general.promedio)}).` +
    (barrios.length > 2 ? ` Le siguen ${esc(barrios[1].barrio)} (${usdCorto(barrios[1].promedio)}) y ${esc(barrios[2].barrio)} (${usdCorto(barrios[2].promedio)}).` : ''));
}

// ---------------------------------------------------------------------------
// Requerimiento 5: baños y habitaciones
// ---------------------------------------------------------------------------
function graficoBaniosHabitaciones(filas) {
  const banios = ordenarSegun(agrupar(filas, 'grupo_banios'), estado.ordenes.grupo_banios);
  const habitaciones = ordenarSegun(agrupar(filas, 'grupo_habitaciones'), estado.ordenes.grupo_habitaciones);

  const gB = obtenerGrafico('grafico-banios', () => configBarras({
    serie: 'Precio promedio', color: PALETA.azul,
    extraTooltip: c => `${num(estado.detalleBanios[c.dataIndex].n)} ventas`,
  }));
  estado.detalleBanios = banios;
  actualizarSerie(gB, banios.map(g => g.clave), banios.map(g => g.promedio));

  const gH = obtenerGrafico('grafico-habitaciones', () => configBarras({
    serie: 'Precio promedio', color: PALETA.violeta,
    extraTooltip: c => `${num(estado.detalleHabitaciones[c.dataIndex].n)} ventas`,
  }));
  estado.detalleHabitaciones = habitaciones;
  actualizarSerie(gH, habitaciones.map(g => g.clave), habitaciones.map(g => g.promedio));

  // Cociente entre el grupo más alto y el más bajo de cada variable
  const extremos = grupos => ({ bajo: grupos[0], alto: grupos[grupos.length - 1], factor: grupos[grupos.length - 1].promedio / grupos[0].promedio });
  const eb = extremos(banios);
  const eh = extremos(habitaciones);

  escribir('frase-banios', banios.length > 1
    ? `Las viviendas con <strong>${esc(eb.alto.clave)}</strong> baños promedian ${usdCorto(eb.alto.promedio)}, frente a ` +
      `${usdCorto(eb.bajo.promedio)} las de <strong>${esc(eb.bajo.clave)}</strong>: <strong>${num(eb.factor, 1)} veces</strong> más.`
    : `En la selección solo hay viviendas con ${esc(eb.bajo.clave)} baños (${usdCorto(eb.bajo.promedio)} de promedio).`);

  let fraseH = habitaciones.length > 1
    ? `Pasar de <strong>${esc(eh.bajo.clave)}</strong> a <strong>${esc(eh.alto.clave)}</strong> habitaciones multiplica el precio por ` +
      `<strong>${num(eh.factor, 1)}</strong> (de ${usdCorto(eh.bajo.promedio)} a ${usdCorto(eh.alto.promedio)}).`
    : `En la selección solo hay viviendas con ${esc(eh.bajo.clave)} habitaciones (${usdCorto(eh.bajo.promedio)} de promedio).`;
  if (banios.length > 1 && habitaciones.length > 1) {
    fraseH += eb.factor > eh.factor
      ? ' Los baños pesan más que las habitaciones en el precio.'
      : ' En esta selección las habitaciones marcan más diferencia que los baños.';
  }
  escribir('frase-habitaciones', fraseH);
}

// ---------------------------------------------------------------------------
// Requerimiento 6: año y década de construcción
// ---------------------------------------------------------------------------
function graficoConstruccion(filas) {
  // Línea: precio promedio por año de construcción (eje X numérico)
  const anios = agrupar(filas, 'yr_built').sort((a, b) => a.clave - b.clave);
  const linea = obtenerGrafico('grafico-anio-construccion', () => ({
    type: 'line',
    data: {
      datasets: [{
        label: 'Precio promedio',
        data: [],
        borderColor: PALETA.principal,
        backgroundColor: conAlfa(PALETA.principal, 0.08),
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderWidth: 2,
      }],
    },
    options: {
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: c => `Construidas en ${c[0].raw.x}`,
            label: c => `Precio promedio: ${usd(c.parsed.y)} (${num(c.raw.n)} ventas)`,
          },
        },
      },
      scales: {
        x: { type: 'linear', grid: { display: false }, ticks: { callback: v => String(v), stepSize: 10 } },
        y: { beginAtZero: true, ticks: { callback: v => usdCorto(v) } },
      },
    },
  }));
  linea.data.datasets[0].data = anios.map(a => ({ x: a.clave, y: a.promedio, n: a.n }));
  linea.update();

  // Barras: precio por m² por década
  const decadas = ordenarSegun(agrupar(filas, 'decada_construccion'), estado.ordenes.decada_construccion);
  const barras = obtenerGrafico('grafico-decada', () => configBarras({
    serie: 'Precio por m²', color: PALETA.verde, formato: v => usd(v),
    extraTooltip: c => `${num(estado.detalleDecadas[c.dataIndex].n)} ventas`,
  }));
  estado.detalleDecadas = decadas;
  actualizarSerie(barras, decadas.map(d => d.clave), decadas.map(d => d.precioM2));

  // Frase de la línea: primera y última década, y renovadas frente a no renovadas
  const primera = decadas[0];
  const ultima = decadas[decadas.length - 1];
  const renovadas = resumir(filas.filter(v => v.renovada === 1));
  const noRenovadas = resumir(filas.filter(v => v.renovada === 0));
  let frase = decadas.length > 1
    ? `Las casas de la década de ${esc(primera.clave)} promedian ${usdCorto(primera.promedio)} y las de ${esc(ultima.clave)}, ${usdCorto(ultima.promedio)}. `
    : `Todas las ventas de la selección son de la década de ${esc(primera.clave)} (${usdCorto(primera.promedio)} de promedio). `;
  if (renovadas.n && noRenovadas.n) {
    frase += `Las renovadas promedian <strong>${usdCorto(renovadas.promedio)}</strong> frente a ${usdCorto(noRenovadas.promedio)} las no renovadas ` +
      `(${pctConSigno(renovadas.promedio / noRenovadas.promedio - 1)}).`;
  }
  escribir('frase-anio-construccion', frase);

  const porM2 = [...decadas].sort((a, b) => b.precioM2 - a.precioM2);
  escribir('frase-decada', decadas.length > 1
    ? `La década con el m² más caro es <strong>${esc(porM2[0].clave)}</strong> (${usd(porM2[0].precioM2)}/m²) y la más barata, ` +
      `<strong>${esc(porM2[porM2.length - 1].clave)}</strong> (${usd(porM2[porM2.length - 1].precioM2)}/m²).`
    : `Precio por m² de la década de ${esc(primera.clave)}: ${usd(primera.precioM2)}.`);
}

// ---------------------------------------------------------------------------
// Requerimiento 7: predicción (resultado global) y simulador
// ---------------------------------------------------------------------------
function graficoPredicciones() {
  const { muestra, total_filas: total } = estado.datos.predicciones;
  const puntos = muestra.map(([real, predicho]) => ({ x: real, y: predicho }));
  const maximo = Math.max(...muestra.flat());

  obtenerGrafico('grafico-predicciones', () => ({
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Ventas', data: puntos, backgroundColor: conAlfa(PALETA.azul, 0.4), borderWidth: 0, pointRadius: 2.5 },
        { label: 'Predicción perfecta', data: [{ x: 0, y: 0 }, { x: maximo, y: maximo }], type: 'line', borderColor: PALETA.naranja, borderWidth: 2, borderDash: [6, 4], pointRadius: 0 },
      ],
    },
    options: {
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          filter: c => c.datasetIndex === 0,
          callbacks: { label: c => `Real ${usd(c.parsed.x)} · Predicho ${usd(c.parsed.y)}` },
        },
      },
      scales: {
        x: { min: 0, title: { display: true, text: 'Precio real' }, ticks: { callback: v => usdCorto(v), maxRotation: 0, maxTicksLimit: 6 } },
        y: { title: { display: true, text: 'Precio predicho' }, ticks: { callback: v => usdCorto(v), maxTicksLimit: 8 } },
      },
    },
  }));

  const lineal = estado.datos.metricas_modelo.find(m => /lineal/i.test(m.modelo)) || modelosOrdenados()[0];
  escribir('frase-predicciones',
    `Se muestran ${num(muestra.length)} de las ${num(total)} predicciones del conjunto de prueba. Cuanto más cerca de la diagonal, mejor la predicción: ` +
    `la regresión lineal se equivoca en promedio <strong>${usd(lineal.mae)}</strong> (MAE).`);
}

function tablaMetricas() {
  const mejor = modelosOrdenados()[0];
  document.querySelector('#tabla-metricas tbody').innerHTML = estado.datos.metricas_modelo.map(m => `
    <tr class="${m === mejor ? 'fila-destacada' : ''}">
      <td>${esc(m.modelo)}</td><td>${num(m.r2, 3)}</td><td>${usd(m.rmse)}</td><td>${usd(m.mae)}</td>
    </tr>`).join('');

  const [primero, segundo] = modelosOrdenados();
  if (segundo) {
    escribir('frase-metricas',
      `<strong>${esc(primero.modelo)}</strong> explica el <strong>${pct(primero.r2)}</strong> de la variación del precio (R² = ${num(primero.r2, 3)}), ` +
      `frente al ${pct(segundo.r2)} de ${esc(segundo.modelo)}, y reduce el error absoluto medio de ${usd(segundo.mae)} a ${usd(primero.mae)} ` +
      `(${pctConSigno(primero.mae / segundo.mae - 1)}). El simulador usa la regresión lineal porque sus coeficientes se pueden interpretar.`);
  }
}

/** Simulador: misma fórmula que la medida DAX 'Precio Estimado'. */
function simulador() {
  const coef = coeficientes();
  const promedios = estado.datos.promedios_simulador;
  const defectos = CONTROLES_SIMULADOR.map(c => document.getElementById(c.id).defaultValue);

  const calcular = () => {
    let precio = coef.intercepto;
    for (const control of CONTROLES_SIMULADOR) {
      const valor = Number(document.getElementById(control.id).value);
      document.getElementById(`${control.id}-valor`).textContent = control.formato(valor);
      precio += coef[control.variable] * valor;
    }
    // Variables sin control: fijas en su promedio de todos los datos
    for (const [variable, promedio] of Object.entries(promedios)) precio += coef[variable] * promedio;

    const m2 = Number(document.getElementById('sim-m2').value);
    if (precio > 0) {
      document.getElementById('sim-precio').textContent = usd(precio);
      escribir('sim-detalle', `≈ ${usd(precio / m2)} por m²`);
    } else {
      document.getElementById('sim-precio').textContent = '—';
      escribir('sim-detalle', 'Combinación fuera del rango del modelo lineal (el precio estimado sería negativo).');
    }
  };

  CONTROLES_SIMULADOR.forEach(c => document.getElementById(c.id).addEventListener('input', calcular));
  document.getElementById('sim-reiniciar').addEventListener('click', () => {
    CONTROLES_SIMULADOR.forEach((c, i) => { document.getElementById(c.id).value = defectos[i]; });
    calcular();
  });
  calcular();

  const decimales = { antiguedad: 1, lat: 4 };
  escribir('sim-fijas', 'Variables fijas en su promedio de todos los datos: ' +
    Object.entries(promedios)
      .map(([v, p]) => `${nombre(v).toLowerCase()} ${num(p, decimales[v] ?? 3)}${v === 'antiguedad' ? ' años' : ''}`)
      .join(' · ') + '.');

  escribir('frase-simulador',
    `Con lo demás igual, cada punto de calidad suma <strong>${usd(coef.grade)}</strong>, cada baño ${usd(coef.bathrooms)} ` +
    `y cada m² ${usd(coef.sqft_living_m2)}; una habitación extra ${coef.bedrooms < 0 ? 'resta' : 'suma'} ${usd(Math.abs(coef.bedrooms))}, ` +
    'porque, a igual superficie, implica ambientes más pequeños.');
}

// ---------------------------------------------------------------------------
// Requerimiento 8: correlación entre superficie y valor
// ---------------------------------------------------------------------------
function graficoSuperficie(filas) {
  const xs = filas.map(v => v.sqft_living_m2);
  const ys = filas.map(v => v.price);
  const r = pearson(xs, ys);
  const tendencia = minimosCuadrados(xs, ys);
  const muestra = muestraUniforme(filas, MAX_PUNTOS_SUPERFICIE);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);

  const grafico = obtenerGrafico('grafico-superficie', () => ({
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Ventas', data: [], backgroundColor: conAlfa(PALETA.principal, 0.35), borderWidth: 0, pointRadius: 2.5 },
        { label: 'Tendencia (mínimos cuadrados)', data: [], type: 'line', borderColor: PALETA.naranja, borderWidth: 3, pointRadius: 0 },
      ],
    },
    options: {
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          filter: c => c.datasetIndex === 0,
          callbacks: { label: c => `${num(c.parsed.x, 1)} m² · ${usd(c.parsed.y)}` },
        },
      },
      scales: {
        x: { min: 0, title: { display: true, text: 'Superficie (m²)' }, ticks: { callback: v => num(v), maxRotation: 0 } },
        y: { title: { display: true, text: 'Precio' }, ticks: { callback: v => usdCorto(v) } },
      },
    },
  }));
  grafico.data.datasets[0].data = muestra.map(v => ({ x: v.sqft_living_m2, y: v.price }));
  grafico.data.datasets[1].data = [
    { x: xMin, y: tendencia.intercepto + tendencia.pendiente * xMin },
    { x: xMax, y: tendencia.intercepto + tendencia.pendiente * xMax },
  ];
  grafico.update();

  document.getElementById('corr-r').textContent = Number.isFinite(r) ? num(r, 3) : '—';
  document.getElementById('corr-r2').textContent = Number.isFinite(r) ? num(r * r, 3) : '—';

  if (!Number.isFinite(r)) {
    escribir('frase-superficie', 'No hay suficientes ventas para calcular la correlación.');
    return;
  }
  const fuerza = Math.abs(r) >= 0.7 ? 'fuerte' : Math.abs(r) >= 0.4 ? 'moderada' : 'débil';
  escribir('frase-superficie',
    `La correlación es <strong>${fuerza} y ${r >= 0 ? 'positiva' : 'negativa'}</strong> (r = ${num(r, 3)}): la superficie explica el ` +
    `${pct(r * r)} de la variación del precio. Según la línea de tendencia, cada m² adicional se asocia con ` +
    `<strong>${usd(tendencia.pendiente)}</strong> más. Se grafican ${num(muestra.length)} de ${num(filas.length)} ventas; la correlación usa todas.`);
}

function graficoCorrelaciones() {
  const correlaciones = [...estado.datos.correlaciones].sort((a, b) => b.correlacion_con_precio - a.correlacion_con_precio);
  const grafico = obtenerGrafico('grafico-correlaciones', () => configBarras({
    horizontal: true,
    serie: 'Correlación con el precio',
    formato: v => num(v, 1),
    formatoTooltip: v => num(v, 3),
  }));
  grafico.options.scales.x.beginAtZero = true;
  actualizarSerie(grafico,
    correlaciones.map(c => nombre(c.variable)),
    correlaciones.map(c => c.correlacion_con_precio),
    correlaciones.map(c => (c.correlacion_con_precio < 0 ? PALETA.rojo : PALETA.principal)));

  const top = correlaciones.slice(0, 3);
  const rBanios = correlacionGlobal('bathrooms');
  const rHabitaciones = correlacionGlobal('bedrooms');
  let frase = `Las variables más asociadas con el precio son ${listaNatural(top.map(c => `<strong>${esc(nombre(c.variable).toLowerCase())}</strong> (r = ${num(c.correlacion_con_precio, 2)})`))}.`;
  if (Number.isFinite(rBanios) && Number.isFinite(rHabitaciones)) {
    frase += ` Los baños (${num(rBanios, 2)}) se relacionan más con el precio que las habitaciones (${num(rHabitaciones, 2)}).`;
  }
  escribir('frase-correlaciones', frase);
}

// ---------------------------------------------------------------------------
// Requerimiento 9: frente al agua y vista
// ---------------------------------------------------------------------------
function graficoAgua(filas) {
  const agua = primaFrenteAgua(filas);
  const grupos = [
    { etiqueta: 'Con frente al agua', r: agua.con, color: PALETA.azul },
    { etiqueta: 'Sin frente al agua', r: agua.sin, color: PALETA.gris },
  ].filter(g => g.r.n > 0);

  const gAgua = obtenerGrafico('grafico-agua', () => configBarras({
    serie: 'Precio promedio',
    extraTooltip: c => `${num(estado.detalleAgua[c.dataIndex].r.n)} ventas`,
  }));
  estado.detalleAgua = grupos;
  actualizarSerie(gAgua, grupos.map(g => g.etiqueta), grupos.map(g => g.r.promedio), grupos.map(g => g.color));

  escribir('frase-agua', Number.isFinite(agua.prima)
    ? `Con frente al agua el precio promedio es <strong>${usdCorto(agua.con.promedio)}</strong>, frente a ${usdCorto(agua.sin.promedio)} sin frente: ` +
      `una prima de <strong>${pctConSigno(agua.prima)}</strong> (${num(agua.con.promedio / agua.sin.promedio, 1)} veces). ` +
      `Son solo ${num(agua.con.n)} ventas (${pct(agua.con.n / filas.length)} de la selección).`
    : `La selección solo tiene viviendas ${agua.con.n ? 'con' : 'sin'} frente al agua (${usdCorto(grupos[0].r.promedio)} de promedio): no se puede calcular la prima.`);

  // Precio promedio según la vista (0 = sin vista, 4 = excelente)
  const vistas = agrupar(filas, 'view').sort((a, b) => a.clave - b.clave);
  const gVista = obtenerGrafico('grafico-vista', () => configBarras({
    serie: 'Precio promedio',
    extraTooltip: c => `${num(estado.detalleVista[c.dataIndex].n)} ventas`,
  }));
  estado.detalleVista = vistas;
  const etiquetaVista = v => (v === 0 ? '0 · sin vista' : v === 4 ? '4 · excelente' : String(v));
  const colores = vistas.map(v => conAlfa(PALETA.azul, 0.35 + 0.65 * (v.clave / 4)));
  actualizarSerie(gVista, vistas.map(v => etiquetaVista(v.clave)), vistas.map(v => v.promedio), colores);

  const peor = vistas[0];
  const mejor = vistas[vistas.length - 1];
  escribir('frase-vista', vistas.length > 1
    ? `Las viviendas con vista <strong>${mejor.clave}</strong> promedian ${usdCorto(mejor.promedio)}: ` +
      `<strong>${num(mejor.promedio / peor.promedio, 1)} veces</strong> el precio de las de vista ${peor.clave} (${usdCorto(peor.promedio)}).`
    : `Todas las ventas de la selección tienen vista ${peor.clave} (${usdCorto(peor.promedio)} de promedio).`);
}

// ---------------------------------------------------------------------------
// Requerimiento 10: segmentación por rangos de precio
// ---------------------------------------------------------------------------
function graficoSegmentos(filas) {
  const orden = estado.ordenes.rango_precio;
  const segmentos = ordenarSegun(agrupar(filas, 'rango_precio'), orden);
  const total = filas.length;

  const grafico = obtenerGrafico('grafico-segmentos', () => ({
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderColor: '#fff', borderWidth: 2 }] },
    options: {
      cutout: '58%',
      // Al cambiar el ancho (por ejemplo, al girar el celular), la leyenda pasa abajo o a la derecha
      onResize: (chart, tamanio) => {
        const posicion = posicionLeyenda(tamanio.width);
        if (chart.options.plugins.legend.position !== posicion) {
          chart.options.plugins.legend.position = posicion;
          chart.update('none');
        }
      },
      plugins: {
        legend: { position: posicionLeyenda(document.getElementById('grafico-segmentos').parentElement.clientWidth) },
        tooltip: { callbacks: { label: c => `${c.label}: ${num(c.parsed)} ventas (${pct(c.parsed / estado.filtradas.length)})` } },
      },
    },
  }));
  actualizarSerie(grafico,
    segmentos.map(s => etiquetaRango(s.clave)),
    segmentos.map(s => s.n),
    segmentos.map(s => COLORES_RANGO[orden.indexOf(s.clave) % COLORES_RANGO.length]));

  document.querySelector('#tabla-segmentos tbody').innerHTML = segmentos.map(s => `
    <tr>
      <td>${esc(etiquetaRango(s.clave))}</td><td>${num(s.n)}</td><td>${pct(s.n / total)}</td>
      <td>${usd(s.promedio)}</td><td>${num(s.m2Promedio, 1)}</td>
    </tr>`).join('');

  const masVentas = [...segmentos].sort((a, b) => b.n - a.n)[0];
  const alto = segmentos[segmentos.length - 1];
  let frase = `El segmento con más ventas es <strong>${esc(etiquetaRango(masVentas.clave))}</strong>, con el <strong>${pct(masVentas.n / total)}</strong> del total.`;
  if (alto !== masVentas) frase += ` El segmento ${esc(etiquetaRango(alto.clave))} representa el ${pct(alto.n / total)}, con ${usdCorto(alto.promedio)} de promedio.`;
  escribir('frase-segmentos', frase);
}

// ---------------------------------------------------------------------------
// Validación estadística (ANOVA): resultado global
// ---------------------------------------------------------------------------
function renderAnova() {
  const alfa = 0.05;
  const factores = [...estado.datos.resultados_anova].sort((a, b) => b.eta2 - a.eta2);

  // Tabla de un factor; fila en verde si p < 0,05
  document.querySelector('#tabla-anova tbody').innerHTML = factores.map(f => `
    <tr class="${f.p_valor < alfa ? 'fila-significativa' : ''}">
      <td>${esc(nombre(f.factor))}</td>
      <td>${num(f.n_grupos)}</td>
      <td>${num(f.F, 1)}</td>
      <td>${cientifico(f.p_valor)}</td>
      <td>${num(f.eta2, 3)}</td>
      <td>${cientifico(f.levene_p)}</td>
      <td>${cientifico(f.welch_p)}</td>
      <td>${cientifico(f.kruskal_p)}</td>
      <td>${esc(f.conclusion)}</td>
    </tr>`).join('');

  // Gráfico de η², de mayor a menor
  const grafico = obtenerGrafico('grafico-eta2', () => configBarras({
    horizontal: true,
    serie: 'η²',
    formato: v => pct(v, 0),
    formatoTooltip: v => `${num(v, 3)} (${pct(v)} de la variación)`,
  }));
  actualizarSerie(grafico, factores.map(f => nombre(f.factor)), factores.map(f => f.eta2),
    factores.map((_, i) => [PALETA.principal, PALETA.azul, PALETA.naranja][i] || conAlfa(PALETA.principal, 0.45)));

  const [f1, f2] = factores;
  escribir('frase-eta2',
    `<strong>${esc(nombre(f1.factor))}</strong> explica el ${pct(f1.eta2)} de la variación de log(price) y ` +
    `<strong>${esc(nombre(f2.factor).toLowerCase())}</strong> el ${pct(f2.eta2)}. ` +
    `${esc(nombre(factores[factores.length - 1].factor))} es el que menos explica (${pct(factores[factores.length - 1].eta2)}).`);

  // ANOVA de dos factores
  const dos = estado.datos.anova_dos_factores;
  document.querySelector('#tabla-anova-dos tbody').innerHTML = dos.map(f => {
    const tieneP = f.p_valor !== null && f.p_valor !== undefined;
    const clase = !tieneP ? '' : f.p_valor < alfa ? 'fila-significativa' : 'fila-no-significativa';
    return `
    <tr class="${clase}">
      <td>${esc(nombre(f.fuente))}${tieneP && f.p_valor >= alfa ? ' (no significativa)' : ''}</td>
      <td>${num(f.suma_cuadrados, 1)}</td>
      <td>${num(f.grados_libertad)}</td>
      <td>${f.F === null || f.F === undefined ? '—' : num(f.F, 2)}</td>
      <td>${tieneP ? cientifico(f.p_valor) : '—'}</td>
    </tr>`;
  }).join('');

  const interaccion = dos.find(f => f.fuente === 'interaccion');
  if (interaccion) {
    escribir('frase-anova-dos', interaccion.p_valor >= alfa
      ? `La interacción <strong>no es significativa</strong> (p = ${num(interaccion.p_valor, 3)} ≥ 0,05): el efecto de los baños sobre el precio ` +
        'no depende de la cantidad de habitaciones. Cada factor actúa por separado.'
      : `La interacción es significativa (p = ${cientifico(interaccion.p_valor)}): el efecto de los baños depende de la cantidad de habitaciones.`);
  }

  // Interpretación en 3 o 4 frases
  const rechazados = factores.filter(f => f.p_valor < alfa).length;
  const kruskalConfirma = factores.every(f => (f.p_valor < alfa) === (f.kruskal_p < alfa));
  const banios = factorAnova('grupo_banios');
  const habitaciones = factorAnova('grupo_habitaciones');
  const frases = [
    rechazados === factores.length
      ? `En los ${num(factores.length)} factores se rechaza H0 (p < 0,05): todos influyen en el precio.`
      : `Se rechaza H0 en ${num(rechazados)} de ${num(factores.length)} factores.`,
    `El factor que más explica el precio es ${esc(nombre(f1.factor).toLowerCase())} (η² = ${num(f1.eta2, 2)}), seguido de ${esc(nombre(f2.factor).toLowerCase())} (η² = ${num(f2.eta2, 2)}).`,
  ];
  if (banios && habitaciones) {
    frases.push(`Los baños (η² = ${num(banios.eta2, 2)}) explican ${num(banios.eta2 / habitaciones.eta2, 1)} veces más que las habitaciones (η² = ${num(habitaciones.eta2, 2)}).`);
  }
  if (kruskalConfirma) frases.push('Kruskal-Wallis, que no supone normalidad, llega a la misma conclusión en todos los factores.');
  escribir('interpretacion-anova', frases.join(' '));
}

// ---------------------------------------------------------------------------
// Portada, conclusiones y limitaciones (todos los datos, sin filtros)
// ---------------------------------------------------------------------------
function renderPortada() {
  const meta = estado.datos.metadatos;
  escribir('portada-dataset',
    `House Sales in King County (Kaggle): <strong>${num(meta.filas_originales)}</strong> ventas originales y ` +
    `<strong>${num(meta.filas_limpias)}</strong> después de la limpieza, del ${formatoFechaLarga.format(parsearFecha(meta.fecha_min))} ` +
    `al ${formatoFechaLarga.format(parsearFecha(meta.fecha_max))}.`);
}

function renderConclusiones() {
  const todas = estado.todas;
  const general = resumir(todas);
  const r = pearson(todas.map(v => v.sqft_living_m2), todas.map(v => v.price));
  const calidad = factorAnova('categoria_calidad');
  const ciudad = factorAnova('ciudad');
  const banios = factorAnova('grupo_banios');
  const habitaciones = factorAnova('grupo_habitaciones');
  const agua = primaFrenteAgua(todas);
  const [mejor, peor] = modelosOrdenados();
  const lineal = estado.datos.metricas_modelo.find(m => /lineal/i.test(m.modelo)) || peor;
  const coef = coeficientes();
  const barrios = agrupar(todas, v => `${v.barrio}|${v.ciudad}`)
    .map(g => ({ ...g, barrio: g.filas[0].barrio }))
    .sort((a, b) => b.promedio - a.promedio)
    .slice(0, 3);
  const renovadas = resumir(todas.filter(v => v.renovada === 1));
  const noRenovadas = resumir(todas.filter(v => v.renovada === 0));
  const baniosPesanMas = banios.eta2 > habitaciones.eta2;

  const hallazgos = [
    {
      cifra: `η² = ${num(calidad.eta2, 2)}`,
      titulo: 'La calidad de construcción y la superficie explican la mayor parte del precio',
      texto: `La categoría de calidad explica por sí sola el ${pct(calidad.eta2, 0)} de la variación del precio y la superficie tiene una correlación de ${num(r, 2)} (R² = ${num(r * r, 2)}). Junto con el resto de las variables, la regresión lineal llega a R² = ${num(lineal.r2, 3)}.`,
    },
    {
      cifra: `×${num(barrios[0].promedio / general.promedio, 1)}`,
      titulo: 'La ubicación multiplica el precio',
      texto: `${esc(barrios[0].barrio)} promedia ${usdCorto(barrios[0].promedio)}, ${num(barrios[0].promedio / general.promedio, 1)} veces el promedio del condado (${usdCorto(general.promedio)}); le siguen ${esc(barrios[1].barrio)} (${usdCorto(barrios[1].promedio)}) y ${esc(barrios[2].barrio)} (${usdCorto(barrios[2].promedio)}). La ciudad explica el ${pct(ciudad.eta2, 0)} de la variación.`,
    },
    {
      cifra: pctConSigno(agua.prima),
      titulo: `El frente al agua multiplica por ${num(agua.con.promedio / agua.sin.promedio, 1)} el precio promedio`,
      texto: `Las ${num(agua.con.n)} casas con frente al agua promedian ${usdCorto(agua.con.promedio)}, frente a ${usdCorto(agua.sin.promedio)} sin frente. Como son solo el ${pct(agua.con.n / todas.length)} de las ventas, explican poco de la variación total (η² = ${num(factorAnova('frente_agua')?.eta2 ?? NaN, 2)}).`,
    },
    {
      cifra: `${num(banios.eta2, 2)} vs. ${num(habitaciones.eta2, 2)}`,
      titulo: baniosPesanMas ? 'Los baños pesan más que las habitaciones' : 'Las habitaciones pesan más que los baños',
      texto: `El η² de los baños es ${num(banios.eta2, 2)} y el de las habitaciones, ${num(habitaciones.eta2, 2)}. En el modelo lineal, a igual superficie, un baño suma ${usd(coef.bathrooms)} y una habitación ${coef.bedrooms < 0 ? 'resta' : 'suma'} ${usd(Math.abs(coef.bedrooms))}.`,
    },
    {
      cifra: `R² ${num(mejor.r2, 3)}`,
      titulo: `El modelo ${esc(mejor.modelo)} predice mejor que el de ${esc(peor.modelo.toLowerCase())}`,
      texto: `El modelo ${esc(mejor.modelo)} explica el ${pct(mejor.r2, 0)} del precio frente al ${pct(peor.r2, 0)} del de ${esc(peor.modelo.toLowerCase())}, con un error absoluto medio de ${usd(mejor.mae)} frente a ${usd(peor.mae)}.`,
    },
  ];
  document.getElementById('hallazgos').innerHTML = hallazgos.map(h => `
    <article class="hallazgo">
      <p class="hallazgo-cifra">${h.cifra}</p>
      <h4>${h.titulo}</h4>
      <p>${h.texto}</p>
    </article>`).join('');

  const recomendaciones = [
    {
      publico: 'Compradores',
      titulo: 'Priorizar calidad y baños antes que habitaciones',
      texto: `Con un presupuesto limitado, conviene una casa mejor construida antes que una más grande en ambientes: un punto más de calidad suma ${usd(coef.grade)} al precio estimado, mientras que una habitación extra, a igual superficie, ${coef.bedrooms < 0 ? `resta ${usd(Math.abs(coef.bedrooms))}` : `suma solo ${usd(coef.bedrooms)}`}.`,
    },
    {
      publico: 'Inversores',
      titulo: 'La remodelación se asocia con más valor',
      texto: `Las casas renovadas promedian ${usdCorto(renovadas.promedio)} frente a ${usdCorto(noRenovadas.promedio)} las no renovadas (${pctConSigno(renovadas.promedio / noRenovadas.promedio - 1)}). Es una diferencia observada, no causal: conviene evaluarla junto con la ubicación.`,
    },
    {
      publico: 'Inmobiliarias',
      titulo: 'Tasar primero por ubicación y calidad',
      texto: `La categoría de calidad (η² = ${num(calidad.eta2, 2)}) y la ciudad (η² = ${num(ciudad.eta2, 2)}) son los factores que más explican el precio. El simulador sirve como primera referencia (R² = ${num(lineal.r2, 3)}, error medio de ${usdCorto(lineal.mae)}).`,
    },
  ];
  document.getElementById('recomendaciones').innerHTML = recomendaciones.map(r => `
    <article class="recomendacion">
      <p class="recomendacion-publico">${r.publico}</p>
      <h4>${r.titulo}</h4>
      <p>${r.texto}</p>
    </article>`).join('');

  const meta = estado.datos.metadatos;
  const zonas = Object.keys(estado.datos.ubicacion).length;
  const limitaciones = [
    `<strong>Un solo año de datos</strong> (del ${formatoFechaLarga.format(parsearFecha(meta.fecha_min))} al ${formatoFechaLarga.format(parsearFecha(meta.fecha_max))}): no permite ver ciclos del mercado ni comparar entre años.`,
    '<strong>Tipo de vivienda derivado:</strong> el dataset no lo informa; se clasificó según la cantidad de plantas y la presencia de sótano.',
    `<strong>Barrios aproximados por código postal</strong> (${num(zonas)} zonas): el dataset no trae nombres de barrio.`,
    '<strong>«Vista al mar» es en realidad frente al agua:</strong> el lago Washington o Puget Sound.',
    '<strong>Sin variables de entorno:</strong> no hay datos de escuelas, transporte ni servicios cercanos.',
  ];
  document.getElementById('limitaciones').innerHTML = limitaciones.map(l => `<li>${l}</li>`).join('');
}

// ---------------------------------------------------------------------------
// Navegación, animaciones y modo presentación
// ---------------------------------------------------------------------------

/** Guarda la altura real de la cabecera para el desplazamiento a las secciones. */
function medirCabecera() {
  const cabecera = document.getElementById('cabecera');
  const actualizar = () => document.documentElement.style.setProperty('--alto-cabecera', `${cabecera.offsetHeight}px`);
  actualizar();
  new ResizeObserver(actualizar).observe(cabecera);
}

/** Menú y filtros desplegables en pantallas chicas. */
function prepararMenu() {
  const alternar = (botonId, panelId) => {
    const boton = document.getElementById(botonId);
    const panel = document.getElementById(panelId);
    boton.addEventListener('click', () => {
      const abierto = panel.classList.toggle('abierto');
      boton.setAttribute('aria-expanded', String(abierto));
    });
    return { boton, panel };
  };
  const menu = alternar('menu-boton', 'menu-enlaces');
  alternar('filtros-boton', 'filtros-campos');
  // Al elegir una sección en el celular, se cierra el menú
  menu.panel.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
    menu.panel.classList.remove('abierto');
    menu.boton.setAttribute('aria-expanded', 'false');
  }));
}

/** Aparición de las secciones, enlace activo del menú y arranque de los KPI. */
function observarSecciones() {
  const secciones = [...document.querySelectorAll('main > section')];

  const aparicion = new IntersectionObserver(entradas => {
    for (const entrada of entradas) {
      if (!entrada.isIntersecting) continue;
      entrada.target.classList.add('visible');
      if (entrada.target.id === 'indicadores' && !estado.kpiVisible) {
        estado.kpiVisible = true;
        calcularKPI(estado.filtradas);
      }
      aparicion.unobserve(entrada.target);
    }
  }, { threshold: 0.08 });
  secciones.forEach(s => aparicion.observe(s));

  const enlaces = [...document.querySelectorAll('.menu-enlaces a')];
  const activa = new IntersectionObserver(entradas => {
    for (const entrada of entradas) {
      if (!entrada.isIntersecting) continue;
      const grupo = entrada.target.dataset.menu;
      enlaces.forEach(a => a.classList.toggle('activo', a.dataset.enlace === grupo));
      const indice = secciones.indexOf(entrada.target);
      const indicador = document.getElementById('indicador-seccion');
      indicador.textContent = `${entrada.target.dataset.titulo} · ${indice + 1} / ${secciones.length}  ← →`;
      indicador.classList.add('visible');
      clearTimeout(indicador._temporizador);
      indicador._temporizador = setTimeout(() => indicador.classList.remove('visible'), 2500);
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  secciones.forEach(s => activa.observe(s));
}

/** Modo presentación: las flechas ← → saltan de sección en sección. */
function modoPresentacion() {
  const secciones = [...document.querySelectorAll('main > section')];

  document.addEventListener('keydown', evento => {
    if (evento.key === 'Escape' && document.activeElement) {
      document.activeElement.blur();   // sale de un control para volver a navegar con flechas
      return;
    }
    if (evento.key !== 'ArrowRight' && evento.key !== 'ArrowLeft') return;
    if (evento.altKey || evento.ctrlKey || evento.metaKey || evento.shiftKey) return;
    // Dentro de un control (por ejemplo, los deslizadores) las flechas siguen funcionando normal
    if (evento.target.closest('input, select, textarea, [contenteditable="true"]')) return;

    evento.preventDefault();
    const margen = document.getElementById('cabecera').offsetHeight + 8;
    let actual = 0;
    secciones.forEach((s, i) => { if (s.getBoundingClientRect().top - margen <= 1) actual = i; });
    const destino = Math.min(secciones.length - 1, Math.max(0, actual + (evento.key === 'ArrowRight' ? 1 : -1)));
    secciones[destino].scrollIntoView({ behavior: estado.reducirMovimiento ? 'auto' : 'smooth', block: 'start' });
  });
}

/** Muestra un aviso de error arriba de la página. */
function mostrarError(html) {
  const aviso = document.getElementById('aviso-error');
  aviso.innerHTML = html;
  aviso.hidden = false;
  document.getElementById('filtros-resumen').textContent = 'No se pudieron cargar los datos.';
}

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------
async function iniciar() {
  medirCabecera();
  prepararMenu();
  modoPresentacion();

  if (typeof Chart === 'undefined') {
    mostrarError('No se pudo cargar Chart.js desde el CDN. Revisa la conexión a internet y recarga la página.');
    observarSecciones();
    return;
  }

  try {
    await cargarDatos();
  } catch (error) {
    mostrarError(`No se pudieron cargar los datos (${esc(error.message)}). Abre la página con un servidor local: ` +
      'desde la carpeta de la web ejecuta <code>python -m http.server 8000</code> y entra a <code>http://localhost:8000</code>.');
    observarSecciones();
    return;
  }

  configurarChart();
  renderPortada();
  notaMesIncompleto();
  prepararFiltros();

  // Resultados globales: se dibujan una sola vez
  graficoPredicciones();
  tablaMetricas();
  simulador();
  graficoCorrelaciones();
  renderAnova();
  renderConclusiones();

  // Resultados que dependen de los filtros
  aplicarFiltros();
  observarSecciones();
}

document.addEventListener('DOMContentLoaded', iniciar);
