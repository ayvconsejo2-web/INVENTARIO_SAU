'use strict';
/* Inventario SAU — web.
   Habla con el Apps Script de la planilla (ver ../apps-script/Code.gs). */

/* ───────────────────────── Estado y utilidades ───────────────────────── */

const CONFIG = window.INVENTARIO_CONFIG || {};
const LS = { cfg: 'inv.cfg', cache: 'inv.cache', cola: 'inv.cola', sel: 'inv.sel', fmt: 'inv.fmt', ubiRel: 'inv.ubiRel' };
const RESPONSABLE = 'Servicios audiovisuales';

const PRESETS = [
  { id: 'r50x30', nombre: 'Rollo 50 × 30 mm', modo: 'rollo', w: 50, h: 30 },
  { id: 'r40x25', nombre: 'Rollo 40 × 25 mm', modo: 'rollo', w: 40, h: 25 },
  { id: 'r60x40', nombre: 'Rollo 60 × 40 mm', modo: 'rollo', w: 60, h: 40 },
  { id: 'r100x50', nombre: 'Rollo 100 × 50 mm', modo: 'rollo', w: 100, h: 50 },
  { id: 'a4', nombre: 'Hoja A4 de 63 × 34 mm (para probar con papel común)', modo: 'a4', w: 63, h: 34 },
  { id: 'libre', nombre: 'Otro tamaño de rollo', modo: 'rollo', w: 50, h: 30, libre: true }
];

const S = {
  cfg: { apiUrl: '', pin: '', usuario: '' },
  equipos: [], mapa: new Map(),
  categorias: [], ubicaciones: [],
  estados: ['Malo', 'Regular', 'Bueno', 'Excelente'],
  situaciones: ['Operativo', 'Prestado', 'En reparación', 'Baja'],
  prefijo: 'SAU-',
  actualizado: '', actualizadoMs: 0, sinRed: false,
  vista: 'escanear',
  modo: 'consulta', relUbi: '', sesion: [], escaneadosIds: new Set(), verFaltan: false,
  actual: null,
  volverFicha: null,
  filtros: { inv: { q: '', categoria: '', ubicacion: '', situacion: '', estado: '' },
             et: { q: '', categoria: '', ubicacion: '', situacion: '', estado: '' } },
  limite: { inv: 150, et: 150 },
  seleccion: new Set(),
  fmt: { preset: 'r50x30', w: 50, h: 30, texto: true },
  cola: [],
  camara: null
};

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sinTildes = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const slug = s => sinTildes(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function guardarLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin espacio o bloqueado */ } }
function leerLS(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }

function pad2(n) { return String(n).padStart(2, '0'); }
function ahoraLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function horaCorta() { const d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function fechaAR(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?$/.exec(s);
  return m ? m[3] + '/' + m[2] + '/' + m[1] + (m[4] ? ' ' + m[4] : '') : s;
}

/** Acepta "SAU-000042", "42" o "SAU'000042" (guion mal leído por el teclado del lector). */
function normalizarId(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!s) return '';
  const letras = S.prefijo.replace(/[^A-Z0-9]/g, '');
  const m = new RegExp('^(?:' + letras + ')?[^A-Z0-9]*(\\d+)$').exec(s);
  return m ? S.prefijo + String(Number(m[1])).padStart(6, '0') : s;
}

function titulo(e) {
  return [e.descripcion, e.marca, e.modelo].filter(Boolean).join(' ') || e.codigo || e.categoria || e.id;
}
function porId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

/* ───────────────────────── Servidor ───────────────────────── */

class ErrorRed extends Error {}
class ErrorPin extends Error {}

async function api(action, datos) {
  let res;
  try {
    // Sin cabecera Content-Type: así el navegador no hace consulta previa (CORS) y Apps Script responde bien.
    res = await fetch(S.cfg.apiUrl, {
      method: 'POST',
      body: JSON.stringify(Object.assign({ pin: S.cfg.pin, usuario: S.cfg.usuario, action: action }, datos || {}))
    });
  } catch (e) {
    throw new ErrorRed('Sin conexión con el servidor.');
  }
  let j;
  try { j = await res.json(); } catch (e) {
    throw new ErrorRed('El servidor no respondió como se esperaba. Revisá la URL del script y que esté publicado para "Cualquier usuario".');
  }
  if (!j.ok) {
    if (/PIN|intentos/i.test(j.error || '')) throw new ErrorPin(j.error);
    throw new Error(j.error || 'Error del servidor.');
  }
  S.sinRed = false;
  return j.data;
}

/* ───────────────────────── Datos locales ───────────────────────── */

function aplicarEquipos(lista) {
  S.equipos = lista.slice().sort(porId);
  S.mapa = new Map(S.equipos.map(e => [e.id, e]));
}

function upsert(item) {
  const actual = S.mapa.get(item.id);
  if (actual) {
    Object.assign(actual, item);
  } else {
    S.equipos.push(item);
    S.mapa.set(item.id, item);
    S.equipos.sort(porId);
  }
  sumarOpciones(item);
  persistir();
}

function sumarOpciones(item) {
  let cambio = false;
  const agrega = (lista, v) => {
    if (v && !lista.some(x => x.toLowerCase() === v.toLowerCase())) { lista.push(v); cambio = true; }
  };
  agrega(S.categorias, item.categoria);
  agrega(S.ubicaciones, item.ubicacion);
  if (cambio) { renderFiltros(); llenarDatalists(); }
}

function persistir() {
  guardarLS(LS.cache, {
    equipos: S.equipos, categorias: S.categorias, ubicaciones: S.ubicaciones,
    estados: S.estados, situaciones: S.situaciones, prefijo: S.prefijo, actualizado: S.actualizado
  });
}

function aplicarDatos(d) {
  aplicarEquipos(d.equipos || []);
  S.categorias = (d.categorias || []).slice();
  S.ubicaciones = (d.ubicaciones || []).slice();
  if (d.estados) S.estados = d.estados;
  if (d.situaciones) S.situaciones = d.situaciones;
  if (d.prefijo) S.prefijo = d.prefijo;
  S.equipos.forEach(sumarOpciones);
}

async function cargarDatos() {
  const d = await api('cargar');
  aplicarDatos(d);
  S.actualizado = horaCorta();
  S.actualizadoMs = Date.now();
  persistir();
  renderTodo();
}

/* ───────────────────────── Cola de escaneos sin conexión ───────────────────────── */

let sincronizando = false;

function encolar(op) {
  S.cola = S.cola.filter(x => !(x.id === op.id && (x.ubicacion || '') === (op.ubicacion || '') && !!x.relevamiento === !!op.relevamiento));
  S.cola.push(op);
  guardarLS(LS.cola, S.cola);
  renderSync();
}

function aplicarLocal(op) {
  const e = S.mapa.get(op.id);
  if (!e) return;
  if (op.ubicacion) e.ubicacion = op.ubicacion;
  e.revision = op.cuando;
  persistir();
}

/** Manda un escaneo; si no hay red lo deja pendiente y actualiza la copia local. */
async function enviarEscaneo(op) {
  try {
    const r = await api('escanear', op);
    upsert(r.item);
    return r;
  } catch (err) {
    if (err instanceof ErrorRed) {
      S.sinRed = true;
      encolar(op);
      aplicarLocal(op);
      return { pendiente: true };
    }
    throw err;
  }
}

async function sincronizarCola() {
  if (sincronizando || !S.cola.length) return;
  sincronizando = true;
  let ok = 0, fallidos = 0;
  try {
    while (S.cola.length) {
      const op = S.cola[0];
      try {
        const r = await api('escanear', op);
        upsert(r.item);
        S.cola.shift();
        ok++;
      } catch (err) {
        if (err instanceof ErrorRed || err instanceof ErrorPin) break;
        S.cola.shift();
        fallidos++;
      }
    }
  } finally {
    sincronizando = false;
    guardarLS(LS.cola, S.cola);
    renderSync();
    renderTodo();
  }
  if (ok) toast(ok + (ok === 1 ? ' escaneo pendiente sincronizado.' : ' escaneos pendientes sincronizados.'));
  if (fallidos) toast(fallidos + ' escaneo(s) pendientes no se pudieron registrar.', 'error');
}

/* ───────────────────────── Avisos, sonido, diálogos ───────────────────────── */

function toast(msg, tipo, ms) {
  const t = document.createElement('div');
  t.className = 'toast' + (tipo === 'error' ? ' error' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms || (tipo === 'error' ? 5200 : 3000));
}

let audioCtx = null;
function beep(ok) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = ok ? 880 : 200;
    g.gain.value = 0.08;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + (ok ? 0.09 : 0.28));
  } catch (e) { /* sin audio */ }
  try { if (navigator.vibrate) navigator.vibrate(ok ? 30 : [70, 40, 70]); } catch (e) { /* sin vibración */ }
}

const dlg = $('#dlg');
function abrirDlg(html) {
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
  const f = dlg.querySelector('form input:not([type=hidden]):not([type=checkbox]), form select');
  if (f) f.focus();
}
function cerrarDlg() { if (dlg.open) dlg.close(); }
dlg.addEventListener('close', () => { S.volverFicha = null; if (S.vista === 'escanear') enfocarScan(); });
dlg.addEventListener('click', e => { if (e.target === dlg) cerrarDlg(); });

function manejarError(err, form) {
  if (err instanceof ErrorPin) {
    cerrarSesion(err.message);
    return;
  }
  const msg = err instanceof ErrorRed
    ? 'No hay conexión. Probá de nuevo cuando vuelva la señal.'
    : (err && err.message) || 'Algo salió mal.';
  if (form) {
    let p = $('.error', form);
    if (!p) { p = document.createElement('p'); p.className = 'error'; p.setAttribute('role', 'alert'); $('.dlg-acc', form).before(p); }
    p.textContent = msg;
  } else {
    toast(msg, 'error');
  }
}

function setBusy(form, on) {
  $$('button[type=submit]', form).forEach(b => { b.disabled = on; });
}

/* ───────────────────────── Piezas de interfaz ───────────────────────── */

function estadoHTML(est) { return '<span class="est est-' + (est ? slug(est) : 'sin') + '"><i></i>' + esc(est || 'Sin evaluar') + '</span>'; }
function situacionHTML(sit) { return sit ? '<span class="sit sit-' + slug(sit) + '">' + esc(sit) + '</span>' : ''; }

const qrCache = new Map();
function qrSvg(texto) {
  if (qrCache.has(texto)) return qrCache.get(texto);
  let svg = '';
  try {
    const q = qrcode(0, 'M');
    q.addData(String(texto).toUpperCase(), 'Alphanumeric');
    q.make();
    svg = q.createSvgTag({ cellSize: 1, margin: 4, scalable: true });
  } catch (e) { svg = ''; }
  qrCache.set(texto, svg);
  return svg;
}

function fichaHTML(e, o) {
  o = o || {};
  const rev = e.revision ? 'Revisado el ' + fechaAR(e.revision) : 'Todavía sin revisar';
  const cinta =
    '<header class="cinta">' +
      '<div class="qr" aria-hidden="true">' + qrSvg(e.id) + '</div>' +
      '<div><div class="cinta-id">' + esc(e.id) + '</div><div class="cinta-sub">' + esc(rev) + '</div></div>' +
    '</header>';

  const chips =
    '<div class="chips">' + estadoHTML(e.estado) + situacionHTML(e.situacion) +
    (Number(e.cantidad) > 1 ? '<span class="cant">' + esc(e.cantidad) + ' unidades</span>' : '') + '</div>';

  const cabecera =
    '<div><h2>' + esc(titulo(e)) + '</h2><p class="sub">' + esc(e.categoria || 'Sin categoría') + '</p></div>';

  if (o.compacta) {
    return '<article class="ficha" data-id="' + esc(e.id) + '">' + cinta +
      '<div class="ficha-cuerpo">' + cabecera + chips +
      (o.mensaje ? '<p>' + o.mensaje + '</p>' : '') +
      '<div class="acciones"><button class="btn sec chico" type="button" data-accion="ficha" data-id="' + esc(e.id) + '">Ver ficha completa</button></div>' +
      '</div></article>';
  }

  const dato = (k, v, cls) => v ? '<div class="' + (cls || '') + '"><dt>' + esc(k) + '</dt><dd' + (cls === 'ancho' ? ' class="notas"' : '') + '>' + esc(v) + '</dd></div>' : '';
  const datos =
    '<dl class="datos">' +
      dato('Ubicación', e.ubicacion || 'Sin ubicación') +
      dato('Código interno', e.codigo) +
      dato('Responsable', RESPONSABLE) +
      dato('Segundo responsable', e.segundo) +
      dato('N° de serie', e.serie) +
      dato('Fecha de adquisición', fechaAR(e.adquisicion)) +
      dato('Dato maestro contable', e.maestro) +
      dato('OC', e.oc) +
      dato('FC', e.fc) +
      dato('Notas', e.notas, 'ancho') +
    '</dl>';

  const id = esc(e.id);
  const acciones =
    '<div class="acciones">' +
      '<button class="btn" type="button" data-accion="mover" data-id="' + id + '">Cambiar ubicación</button>' +
      (e.situacion === 'Prestado'
        ? '<button class="btn sec" type="button" data-accion="devolver" data-id="' + id + '">Devolver</button>'
        : '<button class="btn sec" type="button" data-accion="prestar" data-id="' + id + '">Prestar</button>') +
      '<button class="btn sec" type="button" data-accion="editar" data-id="' + id + '">Editar</button>' +
      (Number(e.cantidad) > 1 ? '<button class="btn sec" type="button" data-accion="dividir" data-id="' + id + '">Dividir lote</button>' : '') +
      '<button class="btn sec" type="button" data-accion="etiqueta" data-id="' + id + '">Etiqueta</button>' +
      '<button class="btn sec" type="button" data-accion="historial" data-id="' + id + '">Historial</button>' +
    '</div>';

  return '<article class="ficha" data-id="' + id + '">' + cinta +
    '<div class="ficha-cuerpo">' + cabecera + chips + datos + acciones + '<div class="historial" data-hist hidden></div></div></article>';
}

function filaHTML(e, conCheck) {
  return '<div class="fila">' +
    (conCheck ? '<label class="chk"><input type="checkbox" data-sel="' + esc(e.id) + '"' + (S.seleccion.has(e.id) ? ' checked' : '') + ' aria-label="Seleccionar ' + esc(e.id) + '"></label>' : '') +
    '<button class="fila-main" type="button" data-accion="ficha" data-id="' + esc(e.id) + '">' +
      '<span class="f-id">' + esc(e.id) + '</span>' +
      '<span class="f-desc"><strong>' + esc(titulo(e)) + '</strong><small>' + esc(e.categoria || 'Sin categoría') + (e.codigo ? ' / ' + esc(e.codigo) : '') + '</small></span>' +
      '<span class="f-cant">' + (Number(e.cantidad) > 1 ? '×' + esc(e.cantidad) : '') + '</span>' +
      '<span class="f-ubi">' + esc(e.ubicacion || 'Sin ubicación') + '</span>' +
      '<span class="f-est">' + estadoHTML(e.estado) + '</span>' +
      '<span class="f-sit">' + situacionHTML(e.situacion) + '</span>' +
    '</button></div>';
}

/* ───────────────────────── Render ───────────────────────── */

function renderTodo() {
  renderSync();
  renderFiltros();
  llenarDatalists();
  if (S.vista === 'inventario') renderLista('inv');
  if (S.vista === 'etiquetas') { renderLista('et'); renderEtiquetas(); }
  refrescarFichaScan();
  renderRel();
}

function renderSync() {
  const el = $('#estadoSync');
  if (!el) return;
  let texto, clase = '';
  if (S.cola.length) { texto = S.cola.length + (S.cola.length === 1 ? ' escaneo pendiente' : ' escaneos pendientes'); clase = 'pendiente'; }
  else if (S.sinRed) { texto = 'Sin conexión'; clase = 'sin-red'; }
  else if (S.actualizado) { texto = 'Actualizado ' + S.actualizado; }
  else { texto = 'Sin datos'; }
  el.className = 'estado-sync ' + clase;
  $('span', el).textContent = texto;
}

function llenarDatalists() {
  $('#lista-categorias').innerHTML = S.categorias.map(c => '<option value="' + esc(c) + '"></option>').join('');
  $('#lista-ubicaciones').innerHTML = S.ubicaciones.map(c => '<option value="' + esc(c) + '"></option>').join('');
}

function construirFiltros() {
  $$('[data-filtros]').forEach(c => {
    const k = c.dataset.filtros;
    c.innerHTML =
      '<input class="buscar" type="search" data-filtro="' + k + '" data-campo="q" placeholder="Buscar por ID, marca, modelo, serie, ubicación" aria-label="Buscar">' +
      '<select data-filtro="' + k + '" data-campo="categoria" aria-label="Categoría"></select>' +
      '<select data-filtro="' + k + '" data-campo="ubicacion" aria-label="Ubicación"></select>' +
      '<select data-filtro="' + k + '" data-campo="situacion" aria-label="Situación"></select>' +
      '<select data-filtro="' + k + '" data-campo="estado" aria-label="Estado"></select>';
  });
}

function renderFiltros() {
  const pares = lista => lista.map(x => [x, x]);
  const defs = {
    categoria: ['Todas las categorías', pares(S.categorias)],
    ubicacion: ['Todas las ubicaciones', pares(S.ubicaciones)],
    situacion: ['Toda situación', pares(S.situaciones)],
    estado: ['Todo estado', [['__sin', 'Sin evaluar']].concat(pares(S.estados))]
  };
  $$('select[data-filtro]').forEach(sel => {
    const k = sel.dataset.filtro, c = sel.dataset.campo;
    const d = defs[c];
    const actual = S.filtros[k][c];
    sel.innerHTML = '<option value="">' + d[0] + '</option>' +
      d[1].map(v => '<option value="' + esc(v[0]) + '"' + (v[0] === actual ? ' selected' : '') + '>' + esc(v[1]) + '</option>').join('');
  });
}

function filtrar(k) {
  const f = S.filtros[k];
  const tokens = sinTildes(f.q).split(/\s+/).filter(Boolean);
  return S.equipos.filter(e => {
    if (f.categoria && e.categoria !== f.categoria) return false;
    if (f.ubicacion && e.ubicacion !== f.ubicacion) return false;
    if (f.situacion && e.situacion !== f.situacion) return false;
    if (f.estado === '__sin') { if (e.estado) return false; }
    else if (f.estado && e.estado !== f.estado) return false;
    if (!tokens.length) return true;
    const b = sinTildes([e.id, e.codigo, e.descripcion, e.categoria, e.marca, e.modelo, e.serie, e.ubicacion, e.segundo, e.oc, e.fc, e.maestro, e.notas].join(' '));
    return tokens.every(t => b.indexOf(t) >= 0);
  });
}

function renderLista(k) {
  const cont = k === 'inv' ? $('#listaInv') : $('#listaEt');
  const conteo = k === 'inv' ? $('#conteoInv') : $('#conteoEt');
  const arr = filtrar(k);
  conteo.textContent = arr.length + ' de ' + S.equipos.length + ' equipos';
  if (!S.equipos.length) {
    cont.innerHTML = '<div class="vacio"><b>Todavía no hay equipos cargados</b>Usá “Nuevo equipo”, o pegá tu planilla en la hoja Equipos y ejecutá Inventario > Asignar IDs a filas nuevas.</div>';
    return;
  }
  if (!arr.length) {
    cont.innerHTML = '<div class="vacio"><b>No hay equipos con esos filtros</b>Probá con otra búsqueda o quitá algún filtro.</div>';
    return;
  }
  const lim = S.limite[k];
  cont.innerHTML = arr.slice(0, lim).map(e => filaHTML(e, k === 'et')).join('') +
    (arr.length > lim ? '<button class="btn sec lista-mas" type="button" data-accion="mas" data-k="' + k + '">Mostrar más (' + (arr.length - lim) + ' restantes)</button>' : '');
}

function refrescarFichaScan() {
  if (S.modo !== 'consulta' || !S.actual) return;
  const e = S.mapa.get(S.actual);
  if (e) $('#resultadoScan').innerHTML = fichaHTML(e);
}

function mostrarFicha(e) {
  S.actual = e.id;
  $('#resultadoScan').innerHTML = fichaHTML(e);
}

function mostrarVacioScan() {
  S.actual = null;
  $('#resultadoScan').innerHTML = S.modo === 'consulta'
    ? '<div class="vacio"><b>Esperando un código</b>Apuntá el lector a una etiqueta, usá la cámara o escribí el número del equipo.</div>'
    : '';
}

function mostrarNoEncontrado(id) {
  S.actual = null;
  $('#resultadoScan').innerHTML = '<div class="aviso"><b>No encontré ' + esc(id) + '</b><br>Revisá que la etiqueta sea de este inventario. Si es un equipo nuevo, cargalo desde Inventario.</div>';
}

function abrirFichaDlg(id) {
  const e = S.mapa.get(id);
  if (!e) return;
  abrirDlg(fichaHTML(e) + '<div class="dlg-cont"><div class="dlg-acc"><button class="btn sec" type="button" data-accion="cerrar">Cerrar</button></div></div>');
}

/* ───── Relevamiento ───── */

function faltantes() {
  if (!S.relUbi) return [];
  return S.equipos.filter(e => e.ubicacion === S.relUbi && e.situacion !== 'Baja' && e.situacion !== 'Prestado' && !S.escaneadosIds.has(e.id));
}

function renderRel() {
  const on = S.modo === 'relevamiento';
  $$('[data-modo]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.modo === S.modo)));
  $('#relPanel').hidden = !on;
  if (!on) { $('#sesionScan').innerHTML = ''; return; }

  const falta = faltantes();
  $('#relCifras').innerHTML =
    '<div><b>' + S.escaneadosIds.size + '</b><span>escaneados</span></div>' +
    (S.relUbi ? '<div><b>' + falta.length + '</b><span>faltan en ' + esc(S.relUbi) + '</span></div>' : '<span class="suave">Elegí una ubicación para empezar.</span>');
  $('#relAcciones').innerHTML =
    (S.relUbi && falta.length ? '<button class="btn sec chico" type="button" data-accion="ver-faltan">' + (S.verFaltan ? 'Ocultar los que faltan' : 'Ver los que faltan') + '</button>' : '') +
    '<button class="btn sec chico" type="button" data-accion="terminar-rel">Terminar relevamiento</button>';
  $('#relFaltan').innerHTML = S.verFaltan && falta.length
    ? '<div class="lista">' + falta.map(e => filaHTML(e, false)).join('') + '</div>' : '';

  $('#sesionScan').innerHTML = S.sesion.length
    ? '<h3>Escaneados en esta sesión</h3>' + S.sesion.map(x =>
        '<div class="sesion-item"><span class="sid">' + esc(x.id) + '</span>' +
        '<span>' + esc(x.titulo) + '<small> ' + esc(x.hora) + '</small></span>' +
        '<span>' + (x.antes ? '<span class="etiqueta-chip alerta">Estaba en ' + esc(x.antes) + '</span> ' : '') +
        (x.aviso ? '<span class="etiqueta-chip alerta">' + esc(x.aviso) + '</span> ' : '') +
        (x.pendiente ? '<span class="etiqueta-chip">Pendiente</span>' : '') + '</span></div>').join('')
    : '';
}

/* ───── Etiquetas ───── */

function presetActual() { return PRESETS.find(p => p.id === S.fmt.preset) || PRESETS[0]; }

function medidasEtiqueta() {
  const p = presetActual();
  if (p.libre) return { modo: 'rollo', w: Math.max(20, Number(S.fmt.w) || 50), h: Math.max(15, Number(S.fmt.h) || 30) };
  return { modo: p.modo, w: p.w, h: p.h };
}

function etiquetaHTML(e) {
  let desc = '';
  if (S.fmt.texto) {
    const mm = [e.marca, e.modelo].filter(Boolean).join(' ');
    const principal = e.descripcion || (mm ? '' : (e.codigo || e.categoria || ''));
    desc = '<div class="d">' +
      (principal ? '<b>' + esc(principal) + '</b>' : '') +
      (mm ? '<span class="mm">' + esc(mm) + '</span>' : '') +
      (e.ubicacion ? '<span class="ub">' + esc(e.ubicacion) + '</span>' : '') +
      '</div>';
  }
  return '<div class="etq"><div class="q">' + qrSvg(e.id) + '</div><div class="t"><div class="id">' + esc(e.id) + '</div>' + desc + '</div></div>';
}

function renderEtiquetas() {
  const sel = $('#fmtPreset');
  if (!sel.options.length) sel.innerHTML = PRESETS.map(p => '<option value="' + p.id + '">' + esc(p.nombre) + '</option>').join('');
  sel.value = S.fmt.preset;
  const p = presetActual();
  $('#fmtAnchoW').hidden = !p.libre;
  $('#fmtAltoW').hidden = !p.libre;
  $('#fmtAncho').value = S.fmt.w;
  $('#fmtAlto').value = S.fmt.h;
  $('#fmtTexto').checked = !!S.fmt.texto;

  const m = medidasEtiqueta();
  $('#fmtNota').textContent = m.modo === 'a4'
    ? 'Imprime una grilla en hoja A4 con guías de corte. Sirve para probar el flujo con papel común antes de comprar la impresora.'
    : 'Cada etiqueta sale en su propia página de ' + m.w + ' × ' + m.h + ' mm. En el diálogo de impresión elegí la impresora de etiquetas, ese mismo tamaño de papel y márgenes en ninguno.';

  const ids = Array.from(S.seleccion).filter(id => S.mapa.has(id)).sort();
  $('#selCont').textContent = ids.length;
  $('#btnImprimir').textContent = ids.length ? 'Imprimir ' + ids.length + (ids.length === 1 ? ' etiqueta' : ' etiquetas') : 'Imprimir etiquetas';

  const prev = $('#prevEtq');
  prev.style.setProperty('--lw', m.w + 'mm');
  prev.style.setProperty('--lh', m.h + 'mm');
  const muestra = ids.length
    ? ids.slice(0, 6).map(id => S.mapa.get(id))
    : [{ id: S.prefijo + '000123', descripcion: 'Descripción', marca: 'Marca', modelo: 'Modelo', ubicacion: 'Ubicación' }];
  prev.innerHTML = muestra.map(etiquetaHTML).join('') +
    (ids.length > 6 ? '<p class="suave" style="align-self:center">y ' + (ids.length - 6) + ' más</p>' : '') +
    (!ids.length ? '<p class="suave" style="align-self:center">Ejemplo. Seleccioná equipos para ver las etiquetas reales.</p>' : '');
}

function imprimirEtiquetas() {
  const ids = Array.from(S.seleccion).filter(id => S.mapa.has(id)).sort();
  if (!ids.length) { toast('Seleccioná al menos un equipo.', 'error'); return; }
  const m = medidasEtiqueta();
  const cols = Math.max(1, Math.floor(190 / m.w));
  $('#zonaImpresion').innerHTML =
    '<div class="' + (m.modo === 'a4' ? 'hoja-a4' : 'hoja-rollo') + '" style="--lw:' + m.w + 'mm;--lh:' + m.h + 'mm;--cols:' + cols + '">' +
    ids.map(id => etiquetaHTML(S.mapa.get(id))).join('') + '</div>';
  let st = $('#estiloPagina');
  if (!st) { st = document.createElement('style'); st.id = 'estiloPagina'; document.head.appendChild(st); }
  st.textContent = m.modo === 'a4' ? '@page{size:A4;margin:10mm}' : '@page{size:' + m.w + 'mm ' + m.h + 'mm;margin:0}';
  document.body.classList.add('imprimiendo');
  setTimeout(() => window.print(), 60);
}
window.addEventListener('afterprint', () => {
  document.body.classList.remove('imprimiendo');
  $('#zonaImpresion').innerHTML = '';
});

/* ───────────────────────── Formularios ───────────────────────── */

function campo(label, name, valor, o) {
  o = o || {};
  return '<label class="campo ' + (o.cls || '') + '"><span>' + esc(label) + '</span>' +
    '<input name="' + name + '" type="' + (o.type || 'text') + '" value="' + esc(valor == null ? '' : valor) + '"' +
    (o.req ? ' required' : '') + (o.list ? ' list="' + o.list + '"' : '') + (o.attrs ? ' ' + o.attrs : '') + ' autocomplete="off"></label>';
}
/** Campo de texto con botón de cámara que lee marca, modelo o N° de serie desde una foto. */
function campoFoto(label, name, valor, tipo) {
  const ayuda = { marca: 'Sacarle una foto a la marca (o a la etiqueta completa)', modelo: 'Sacarle una foto al modelo (o a la etiqueta completa)', serie: 'Sacarle una foto al número de serie (o a la etiqueta completa)' }[tipo];
  return '<div class="campo"><span>' + esc(label) + '</span>' +
    '<div class="con-boton"><input name="' + name + '" type="text" value="' + esc(valor || '') + '" autocomplete="off" aria-label="' + esc(label) + '">' +
    '<button class="btn sec" type="button" data-accion="foto-campo" title="' + ayuda + '">' +
    '<svg class="icono" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg><span>Foto</span></button></div>' +
    '<input type="file" accept="image/*" capture="environment" class="foto-input" data-tipo="' + tipo + '" hidden>' +
    '<div class="foto-res" aria-live="polite" hidden></div></div>';
}
function selector(label, name, opciones, valor, cls) {
  return '<label class="campo ' + (cls || '') + '"><span>' + esc(label) + '</span><select name="' + name + '">' +
    opciones.map(o => '<option' + (o === valor ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select></label>';
}

function selectorEstado(label, name, valor) {
  const ops = [['', 'Sin evaluar']].concat(S.estados.map(x => [x, x]));
  return '<label class="campo"><span>' + esc(label) + '</span><select name="' + name + '">' +
    ops.map(o => '<option value="' + esc(o[0]) + '"' + (o[0] === valor ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') +
    '</select></label>';
}

function formEquipo(e, o) {
  o = o || {};
  const v = e || {};
  const esNuevo = !e || !e.id;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v.adquisicion || '');
  const fechaCampo = v.adquisicion && !iso
    ? campo('Fecha de adquisición', 'adquisicion', v.adquisicion)
    : campo('Fecha de adquisición', 'adquisicion', v.adquisicion || '', { type: 'date' });
  return '<form class="dlg-cont" data-form="equipo" data-id="' + esc(v.id || '') + '" data-prestado="' + (v.situacion === 'Prestado' ? 'si' : 'no') + '">' +
    '<h2>' + (esNuevo ? 'Nuevo equipo' : 'Editar ' + esc(v.id)) + '</h2>' +
    '<div class="grid-form">' +
      campo('Código interno', 'codigo', v.codigo) +
      campo('Descripción', 'descripcion', v.descripcion, { cls: 'ancho' }) +
      campo('Categoría', 'categoria', v.categoria, { list: 'lista-categorias' }) +
      campoFoto('Marca', 'marca', v.marca, 'marca') +
      campoFoto('Modelo', 'modelo', v.modelo, 'modelo') +
      campoFoto('N° de serie', 'serie', v.serie, 'serie') +
      campo('Cantidad', 'cantidad', v.cantidad || 1, { type: 'number', attrs: 'min="1" step="1" inputmode="numeric"' }) +
      campo('Ubicación', 'ubicacion', v.ubicacion, { list: 'lista-ubicaciones' }) +
      selectorEstado('Estado', 'estado', v.estado === undefined ? 'Bueno' : v.estado) +
      selector('Situación', 'situacion', S.situaciones, v.situacion || 'Operativo') +
      campo('Segundo responsable (quién lo tiene prestado)', 'segundo', v.segundo, { cls: 'campo-segundo' }) +
      fechaCampo +
      campo('Dato maestro contable', 'maestro', v.maestro) +
      campo('OC', 'oc', v.oc) +
      campo('FC', 'fc', v.fc) +
      '<label class="campo ancho"><span>Notas</span><textarea name="notas">' + esc(v.notas || '') + '</textarea></label>' +
    '</div>' +
    '<div class="dlg-acc">' +
      '<button class="btn sec" type="button" data-accion="cancelar-form">Cancelar</button>' +
      (esNuevo ? '<button class="btn sec" type="submit" name="modo" value="otro">Guardar y cargar otro</button>' : '') +
      '<button class="btn" type="submit" name="modo" value="uno">Guardar</button>' +
    '</div></form>';
}

function formSimple(tipo, id, titulo_, cuerpo, boton) {
  return '<form class="dlg-cont" data-form="' + tipo + '" data-id="' + esc(id) + '"><h2>' + titulo_ + '</h2>' + cuerpo +
    '<div class="dlg-acc"><button class="btn sec" type="button" data-accion="cancelar-form">Cancelar</button>' +
    '<button class="btn" type="submit">' + boton + '</button></div></form>';
}

function finForm() {
  const id = S.volverFicha;
  S.volverFicha = null;
  if (id && S.mapa.has(id)) abrirFichaDlg(id); else cerrarDlg();
  refrescarFichaScan();
  if (S.vista === 'inventario' || S.vista === 'etiquetas') renderTodo();
}

async function enviarForm(f, submitter) {
  const tipo = f.dataset.form;
  const id = f.dataset.id;
  const fd = new FormData(f);
  const val = {};
  fd.forEach((v, k) => { val[k] = String(v).trim(); });
  setBusy(f, true);
  try {
    if (tipo === 'equipo') {
      const item = Object.assign({}, val);
      delete item.modo;
      if (id) item.id = id;
      if (item.situacion !== 'Prestado') item.segundo = '';
      const r = await api('guardar', { item: item });
      upsert(r.item);
      if (!id) {
        S.seleccion.add(r.item.id);
        guardarLS(LS.sel, Array.from(S.seleccion));
        toast(r.item.id + ' guardado. Quedó en la lista de etiquetas.');
        if (submitter && submitter.value === 'otro') {
          const copia = Object.assign({}, r.item, { id: '', codigo: '', serie: '', notas: '', revision: '' });
          abrirDlg(formEquipo(copia));
          renderTodo();
          return;
        }
      } else {
        toast(r.item.id + ' actualizado.');
      }
      finForm();
    } else if (tipo === 'mover') {
      const r = await enviarEscaneo({ id: id, ubicacion: val.ubicacion, relevamiento: false, cuando: ahoraLocal() });
      toast(r.pendiente ? 'Sin señal: el cambio se enviará cuando vuelva la conexión.' : 'Ubicación actualizada.');
      finForm();
    } else if (tipo === 'prestar') {
      const item = { id: id, situacion: 'Prestado', segundo: val.segundo };
      if (val.ubicacion) item.ubicacion = val.ubicacion;
      const r = await api('guardar', { item: item });
      upsert(r.item);
      toast('Prestado a ' + val.segundo + '.');
      finForm();
    } else if (tipo === 'devolver') {
      const r = await api('guardar', { item: { id: id, situacion: 'Operativo', segundo: '', ubicacion: val.ubicacion, estado: val.estado } });
      upsert(r.item);
      toast('Devuelto y marcado como operativo.');
      finForm();
    } else if (tipo === 'dividir') {
      const r = await api('dividir', { id: id, cantidad: Number(val.cantidad), ubicacion: val.ubicacion });
      upsert(r.original);
      upsert(r.nuevo);
      S.seleccion.add(r.nuevo.id);
      guardarLS(LS.sel, Array.from(S.seleccion));
      toast('Lote dividido. La parte nueva es ' + r.nuevo.id + ' y quedó en la lista de etiquetas.');
      finForm();
    } else if (tipo === 'sesion') {
      S.cfg.usuario = val.usuario || S.cfg.usuario;
      guardarLS(LS.cfg, S.cfg);
      toast('Nombre actualizado.');
      cerrarDlg();
    }
  } catch (err) {
    setBusy(f, false);
    manejarError(err, f);
  }
}

document.addEventListener('submit', ev => {
  const f = ev.target.closest('form[data-form]');
  if (!f) return;
  ev.preventDefault();
  enviarForm(f, ev.submitter);
});

document.addEventListener('change', ev => {
  const t = ev.target;
  if (t.name === 'situacion' && t.form && t.form.dataset.form === 'equipo') {
    t.form.dataset.prestado = t.value === 'Prestado' ? 'si' : 'no';
  }
});

/* ───────────────────────── Escaneo ───────────────────────── */

function enfocarScan() {
  if (S.vista !== 'escanear' || dlg.open) return;
  if (window.matchMedia && matchMedia('(pointer: fine)').matches) $('#scanInput').focus({ preventScroll: true });
}

let cadena = Promise.resolve();
function procesarCodigo(txt) {
  cadena = cadena.then(() => procesar(txt)).catch(err => manejarError(err));
  return cadena;
}

async function procesar(txt) {
  const id = normalizarId(txt);
  if (!id) return;
  let e = S.mapa.get(id);
  if (!e && navigator.onLine !== false) {
    try { await cargarDatos(); e = S.mapa.get(id); } catch (err) { if (err instanceof ErrorPin) throw err; }
  }
  if (!e) { beep(false); mostrarNoEncontrado(id); return; }

  if (S.modo === 'relevamiento') { await registrarRelevamiento(e); return; }

  beep(true);
  mostrarFicha(e);
  try {
    const r = await enviarEscaneo({ id: e.id, relevamiento: false, cuando: ahoraLocal() });
    if (!r.pendiente) refrescarFichaScan();
  } catch (err) {
    if (err instanceof ErrorPin) throw err;
    toast('No se pudo registrar la revisión: ' + err.message, 'error');
  }
}

async function registrarRelevamiento(e) {
  if (!S.relUbi) {
    beep(false);
    toast('Elegí primero la ubicación que estás relevando.', 'error');
    $('#relUbi').focus();
    return;
  }
  const antes = e.ubicacion;
  const r = await enviarEscaneo({ id: e.id, ubicacion: S.relUbi, relevamiento: true, cuando: ahoraLocal() });
  const item = S.mapa.get(e.id) || e;
  S.escaneadosIds.add(e.id);
  const aviso = item.situacion === 'Prestado' ? 'Figura como prestado' : item.situacion === 'Baja' ? 'Figura como baja' : '';
  S.sesion.unshift({
    id: e.id, titulo: titulo(item), hora: horaCorta(),
    antes: antes && antes !== S.relUbi ? antes : '', aviso: aviso, pendiente: !!r.pendiente
  });
  beep(true);
  S.actual = e.id;
  const msg = antes && antes !== S.relUbi
    ? 'Estaba registrado en <b>' + esc(antes) + '</b>. Ahora figura en <b>' + esc(S.relUbi) + '</b>.'
    : 'Verificado en <b>' + esc(S.relUbi) + '</b>.';
  $('#resultadoScan').innerHTML = fichaHTML(item, { compacta: true, mensaje: msg });
  renderRel();
}


/* ───────────────────────── Foto del número de serie ───────────────────────── */

const SERIE = { ocr: null, cargandoOcr: null };

function cargarScript(src) {
  return new Promise((ok, mal) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = ok;
    el.onerror = () => mal(new Error('No se pudo cargar ' + src));
    document.head.appendChild(el);
  });
}

function urlAbs(rel) { return new URL(rel, document.baseURI).href; }

async function motorOcr() {
  if (SERIE.ocr) return SERIE.ocr;
  if (!SERIE.cargandoOcr) {
    SERIE.cargandoOcr = (async () => {
      if (typeof Tesseract === 'undefined') await cargarScript('vendor/tesseract/tesseract.min.js');
      const w = await Tesseract.createWorker('eng', 1, {
        workerPath: urlAbs('vendor/tesseract/worker.min.js'),
        corePath: urlAbs('vendor/tesseract/'),
        langPath: urlAbs('vendor/tesseract/lang'),
        workerBlobURL: false,
        gzip: true
      });
      await w.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
      SERIE.ocr = w;
      return w;
    })().catch(err => { SERIE.cargandoOcr = null; throw err; });
  }
  return SERIE.cargandoOcr;
}

async function imagenACanvas(file, lado) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    bmp = await new Promise((ok, mal) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = mal;
      im.src = URL.createObjectURL(file);
    });
  }
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, lado / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

/** Escala de grises y contraste: ayuda con etiquetas plateadas o con reflejos. */
function realzar(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data, n = d.length / 4, hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = g; hist[g]++;
  }
  let acc = 0, lo = 0, hi = 255;
  for (let g = 0; g < 256; g++) { acc += hist[g]; if (acc > n * 0.01) { lo = g; break; } }
  acc = 0;
  for (let g = 255; g >= 0; g--) { acc += hist[g]; if (acc > n * 0.01) { hi = g; break; } }
  const rango = Math.max(40, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, (d[i] - lo) * 255 / rango));
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const RX_SERIE = /(?:\bs\s*\/\s*n\b|\bsn\b|\bs\.n\.?|serial(?:\s*(?:no\.?|n[°ºo]|number|num\.?))?|\bser\.?\s*(?:no\.?|n[°º])|n[°º]\s*(?:de\s*)?serie|\bserie)\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-\/.]{3,})/gi;
const RX_MODELO = /(?:\bmodel(?:o|\s*(?:no\.?|n[°ºo]|number))?|\bmod\.?|\btype|\btipo|\bm\s*\/\s*n|\bp\s*\/\s*n|\bpart\s*(?:no\.?|number)?)\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-\/.]{2,})/gi;

const MARCAS_CONOCIDAS = ['Epson', 'Sony', 'Shure', 'Sennheiser', 'Yamaha', 'Behringer', 'Blackmagic', 'Panasonic', 'Canon', 'Samsung', 'LG',
  'Philips', 'Hikvision', 'JBL', 'Bose', 'Audio-Technica', 'Lenovo', 'HP', 'Dell', 'TP-Link', 'Chauvet', 'Roland', 'Allen & Heath', 'AKG', 'Rode',
  'Logitech', 'Elgato', 'Datavideo', 'Teradek', 'Aputure', 'Godox', 'Manfrotto', 'Pioneer', 'Denon', 'Mackie', 'QSC', 'Crown', 'Peavey', 'Kramer',
  'Extron', 'Crestron', 'AVer', 'Poly', 'Jabra', 'BenQ', 'Optoma', 'ViewSonic', 'NEC', 'Hitachi', 'Acer', 'Asus', 'Xiaomi', 'Google', 'Apple',
  'Ubiquiti', 'Cisco', 'D-Link', 'Netgear', 'MikroTik', 'Seagate', 'SanDisk', 'Kingston', 'Neewer', 'Lumens', 'Marshall', 'Atomos', 'Tascam',
  'Zoom', 'Presonus', 'Focusrite', 'Neumann', 'Electro-Voice', 'Dynacord', 'Soundcraft', 'Midas', 'Klark Teknik', 'Hollyland', 'Ecler', 'Novik'];

function sinSignos(v) { return String(v).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function limpiarToken(v) { return String(v).replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/gi, '').toUpperCase(); }

function marcaConocida(texto) {
  const plano = ' ' + String(texto).toLowerCase().replace(/[^a-z0-9&]+/g, ' ') + ' ';
  const propias = Array.from(new Set(S.equipos.map(e => e.marca).filter(Boolean)));
  const hallazgos = [];
  propias.concat(MARCAS_CONOCIDAS).forEach(m => {
    const n = ' ' + String(m).toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim() + ' ';
    if (n.trim().length >= 2 && plano.indexOf(n) >= 0 && !hallazgos.some(h => sinSignos(h) === sinSignos(m))) hallazgos.push(m);
  });
  return hallazgos;
}

/** Reparte el texto de una foto en candidatos para marca, modelo y N° de serie. */
function analizarTexto(texto) {
  const pts = { serie: new Map(), modelo: new Map(), marca: new Map() };
  const sumar = (tipo, v, p) => { if (v) pts[tipo].set(v, Math.max(pts[tipo].get(v) || 0, p)); };
  const malos = /^(?:MODEL|MODELO|INPUT|OUTPUT|MADE|CLASS|SERIAL|SERIE|TYPE|TIPO|WARNING|CAUTION)/;
  const esFecha = v => /^\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/.test(v);
  const esElectrico = v => /^\d+([.\-\/]\d+)*(V|W|HZ|A|MA|VA|VDC|VAC|KG|MM)$/i.test(v);

  const modelosEtiquetados = new Set();
  let m;
  RX_MODELO.lastIndex = 0;
  while ((m = RX_MODELO.exec(texto))) {
    const v = limpiarToken(m[1]);
    if (v.length >= 3 && /\d/.test(v) && !esFecha(v) && !esElectrico(v)) { modelosEtiquetados.add(v); sumar('modelo', v, 20 + (v.indexOf('-') >= 0 ? 2 : 0)); }
  }
  RX_SERIE.lastIndex = 0;
  const seriesEtiquetadas = new Set();
  while ((m = RX_SERIE.exec(texto))) {
    const v = limpiarToken(m[1]);
    if (v.length >= 5 && v.length <= 32 && /\d/.test(v)) { seriesEtiquetadas.add(v); sumar('serie', v, 20); }
  }
  texto.split(/[\s|,;]+/).forEach(t => {
    const v = limpiarToken(t);
    if (!v || /:/.test(t) || malos.test(v) || esFecha(v) || esElectrico(v) || !/\d/.test(v)) return;
    const mixto = /[A-Z]/.test(v) && /\d/.test(v);
    if (v.length >= 5 && v.length <= 32 && !modelosEtiquetados.has(v)) sumar('serie', v, (mixto ? 3 : 0) + (v.length >= 8 && v.length <= 20 ? 2 : 0));
    if (v.length >= 3 && v.length <= 20 && mixto && !seriesEtiquetadas.has(v)) sumar('modelo', v, (v.indexOf('-') >= 0 ? 3 : 0) + (v.length <= 12 ? 1 : 0));
  });
  // Un valor etiquetado como modelo no es el número de serie, y al revés.
  modelosEtiquetados.forEach(v => pts.serie.delete(v));
  seriesEtiquetadas.forEach(v => { if (!modelosEtiquetados.has(v)) pts.modelo.delete(v); });

  marcaConocida(texto).forEach(mc => sumar('marca', mc, 20));
  texto.split('\n').map(l => l.trim()).filter(l => /^[A-Za-zÁÉÍÓÚÑáéíóúñ&\-\s]{2,24}$/.test(l)).slice(0, 3).forEach(l => {
    const v = l.replace(/\s+/g, ' ');
    if (!/^(model|modelo|made|input|output|serial|serie|warning|caution)/i.test(v)) sumar('marca', v, 1);
  });
  const orden = mapa => Array.from(mapa.entries()).sort((a, b) => b[1] - a[1]);
  return {
    marca: orden(pts.marca), modelo: orden(pts.modelo), serie: orden(pts.serie)
  };
}

/** Prueba la foto entera y después recortes que se superponen: una etiqueta chica dentro de una foto grande no se detecta entera. */
async function codigoDeBarras(file) {
  if (typeof Html5Qrcode === 'undefined') return [];
  let cont = $('#lectorFoto');
  if (!cont) {
    cont = document.createElement('div');
    cont.id = 'lectorFoto';
    cont.style.cssText = 'position:absolute;left:-9999px;width:300px;height:300px';
    document.body.appendChild(cont);
  }
  const F = Html5QrcodeSupportedFormats;
  const intentar = async blob => {
    const lector = new Html5Qrcode('lectorFoto', {
      verbose: false,
      formatsToSupport: [F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.ITF, F.UPC_A, F.UPC_E, F.CODABAR]
    });
    try {
      const r = await lector.scanFile(new File([blob], 'foto.png', { type: 'image/png' }), false);
      return r ? String(r).trim() : '';
    } catch (e) { return ''; }
    finally { try { lector.clear(); } catch (e) { /* nada */ } }
  };
  const aBlob = c => new Promise(ok => c.toBlob(ok, 'image/png'));
  const base = await imagenACanvas(file, 1600);
  let r = await intentar(await aBlob(base));
  if (r) return [r];
  for (const n of [2, 3]) {
    const w = Math.min(base.width, Math.round(base.width / n * 1.4)), h = Math.min(base.height, Math.round(base.height / n * 1.4));
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const t = document.createElement('canvas');
        t.width = w; t.height = h;
        t.getContext('2d').drawImage(base, i * (base.width - w) / (n - 1), j * (base.height - h) / (n - 1), w, h, 0, 0, w, h);
        r = await intentar(await aBlob(t));
        if (r) return [r];
      }
    }
  }
  return [];
}

function mostrarResultadoFoto(cont, estado, titulo_, otros, nota) {
  cont.hidden = false;
  cont.dataset.estado = estado;
  let html = '';
  if (estado === 'leyendo') {
    html = '<span class="girando" aria-hidden="true"></span> ' + esc(nota);
  } else if (estado === 'ok') {
    html = '<b>' + esc(titulo_) + '</b> ' + esc(nota || '');
    if (otros.length) {
      html += '<div class="foto-otros"><span>¿No es ese?</span>' +
        otros.map(v => '<button type="button" class="etiqueta-chip" data-accion="usar-foto" data-valor="' + esc(v) + '">' + esc(v) + '</button>').join('') + '</div>';
    }
  } else {
    html = esc(nota);
  }
  cont.innerHTML = html;
}

const NOMBRE_CAMPO = { marca: 'la marca', modelo: 'el modelo', serie: 'el número de serie' };
const ROTULO_CAMPO = { marca: 'Marca', modelo: 'Modelo', serie: 'N° de serie' };

async function leerCampoDeFoto(file, campoEl, tipo) {
  const form = campoEl.closest('form');
  const input = campoEl.querySelector('.con-boton input');
  const res = campoEl.querySelector('.foto-res');
  const boton = campoEl.querySelector('[data-accion="foto-campo"]');
  boton.disabled = true;
  try {
    let porBarras = [];
    if (tipo === 'serie') {
      mostrarResultadoFoto(res, 'leyendo', '', [], 'Buscando un código de barras…');
      porBarras = await codigoDeBarras(file);
    }
    let cand;
    if (porBarras.length) {
      cand = { marca: [], modelo: [], serie: [[porBarras[0], 30]] };
    } else {
      mostrarResultadoFoto(res, 'leyendo', '', [], SERIE.ocr ? 'Leyendo el texto de la foto…' : 'Leyendo el texto de la foto. La primera vez tarda unos segundos más…');
      const canvas = realzar(await imagenACanvas(file, 2000));
      const w = await motorOcr();
      const { data } = await w.recognize(canvas);
      cand = analizarTexto(data.text || '');
    }
    const propios = cand[tipo].map(x => x[0]);
    if (!propios.length) {
      const que = tipo === 'serie' ? 'un número de serie' : tipo === 'modelo' ? 'un modelo' : 'una marca';
      mostrarResultadoFoto(res, 'vacio', '', [], 'No encontré ' + que + ' en la foto. Probá de nuevo más cerca, con buena luz y sin reflejos, o escribilo a mano.');
      return;
    }
    input.value = propios[0];
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Si la foto era de la etiqueta completa, completa también los otros casilleros que estén vacíos y tengan un dato claro.
    const tambien = [];
    ['marca', 'modelo', 'serie'].forEach(t => {
      if (t === tipo || !cand[t].length || cand[t][0][1] < 20) return;
      const otro = form && form.elements[t];
      if (otro && !otro.value.trim()) { otro.value = cand[t][0][0]; tambien.push(ROTULO_CAMPO[t]); }
    });
    const porTexto = !porBarras.length;
    const aviso = (porBarras.length ? 'Se leyó del código de barras. ' : '') +
      (tambien.length ? 'También completé: ' + tambien.join(' y ') + '. ' : '') +
      (porTexto ? 'El texto de una foto puede confundir O/0, I/1 o S/5: comparalo con la etiqueta antes de guardar.' : '');
    mostrarResultadoFoto(res, 'ok', 'Leído: ' + propios[0] + '.', propios.slice(1, 5), aviso.trim());
  } catch (err) {
    mostrarResultadoFoto(res, 'vacio', '', [], 'No pude leer la foto' + (navigator.onLine === false && !SERIE.ocr ? ' (la primera vez necesita conexión para preparar el lector)' : '') + '. Escribí ' + NOMBRE_CAMPO[tipo] + ' a mano.');
  } finally {
    boton.disabled = false;
  }
}

document.addEventListener('change', ev => {
  const inp = ev.target.closest && ev.target.closest('.foto-input');
  if (!inp || !inp.files || !inp.files[0]) return;
  leerCampoDeFoto(inp.files[0], inp.closest('.campo'), inp.dataset.tipo);
});

let ultimoCamara = { t: '', ms: 0 };
function alLeerCamara(txt) {
  const ahora = Date.now();
  if (txt === ultimoCamara.t && ahora - ultimoCamara.ms < 2500) return;
  ultimoCamara = { t: txt, ms: ahora };
  procesarCodigo(txt);
}

async function alternarCamara() {
  if (S.camara) { await detenerCamara(); return; }
  if (typeof Html5Qrcode === 'undefined') { toast('No se cargó el lector de cámara.', 'error'); return; }
  const visor = $('#visor');
  visor.hidden = false;
  try {
    const c = new Html5Qrcode('visor', {
      verbose: false,
      formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE, Html5QrcodeSupportedFormats.CODE_128]
    });
    await c.start({ facingMode: 'environment' },
      { fps: 10, qrbox: (w, h) => { const l = Math.floor(Math.min(w, h) * 0.7); return { width: l, height: l }; } },
      alLeerCamara, () => {});
    S.camara = c;
    $('#btnCamara span').textContent = 'Cerrar cámara';
  } catch (err) {
    visor.hidden = true;
    const https = location.protocol === 'https:' || location.hostname === 'localhost';
    toast(https ? 'No pude abrir la cámara. Revisá el permiso del navegador.' : 'La cámara solo funciona en páginas con HTTPS.', 'error');
  }
}

async function detenerCamara() {
  const c = S.camara;
  if (!c) return;
  S.camara = null;
  try { await c.stop(); c.clear(); } catch (e) { /* ya estaba detenida */ }
  $('#visor').hidden = true;
  $('#btnCamara span').textContent = 'Cámara';
}

$('#formScan').addEventListener('submit', ev => {
  ev.preventDefault();
  const input = $('#scanInput');
  const v = input.value;
  input.value = '';
  procesarCodigo(v);
  enfocarScan();
});

$('#relUbi').addEventListener('input', ev => {
  S.relUbi = ev.target.value.trim();
  guardarLS(LS.ubiRel, S.relUbi);
  renderRel();
});

/* ───────────────────────── Acciones ───────────────────────── */

async function accion(btn) {
  const a = btn.dataset.accion;
  const id = btn.dataset.id;
  const enDlg = dlg.contains(btn);
  const e = id ? S.mapa.get(id) : null;
  const volver = () => { S.volverFicha = enDlg ? id : null; };

  switch (a) {
    case 'ficha': if (e) abrirFichaDlg(id); break;
    case 'cerrar': cerrarDlg(); break;
    case 'cancelar-form': finForm(); break;
    case 'foto-campo': { const inp = btn.closest('.campo').querySelector('.foto-input'); inp.value = ''; inp.click(); break; }
    case 'usar-foto': {
      const cp = btn.closest('.campo');
      cp.querySelector('.con-boton input').value = btn.dataset.valor;
      cp.querySelector('.foto-res').hidden = true;
      break;
    }
    case 'nuevo': S.volverFicha = null; abrirDlg(formEquipo(null)); break;
    case 'editar': if (e) { volver(); abrirDlg(formEquipo(e)); } break;
    case 'mover':
      if (e) {
        volver();
        abrirDlg(formSimple('mover', id, 'Cambiar ubicación de ' + esc(id),
          '<p class="suave">' + esc(titulo(e)) + '. Ahora en ' + esc(e.ubicacion || 'ninguna ubicación') + '.</p>' +
          campo('Nueva ubicación', 'ubicacion', '', { list: 'lista-ubicaciones', req: true }), 'Guardar'));
      }
      break;
    case 'prestar':
      if (e) {
        volver();
        abrirDlg(formSimple('prestar', id, 'Prestar ' + esc(id),
          '<p class="suave">' + esc(titulo(e)) + '</p>' +
          campo('Quién lo recibe', 'segundo', '', { req: true }) +
          campo('Dónde va (opcional)', 'ubicacion', e.ubicacion, { list: 'lista-ubicaciones' }), 'Registrar préstamo'));
      }
      break;
    case 'devolver':
      if (e) {
        volver();
        abrirDlg(formSimple('devolver', id, 'Devolver ' + esc(id),
          '<p class="suave">' + esc(titulo(e)) + '. Lo tiene ' + esc(e.segundo || 'otra persona') + '.</p>' +
          campo('Ubicación al volver', 'ubicacion', '', { list: 'lista-ubicaciones', req: true }) +
          selectorEstado('Estado al volver', 'estado', e.estado || ''), 'Registrar devolución'));
      }
      break;
    case 'dividir':
      if (e) {
        volver();
        abrirDlg(formSimple('dividir', id, 'Dividir el lote ' + esc(id),
          '<p class="suave">' + esc(titulo(e)) + '. Tiene ' + esc(e.cantidad) + ' unidades. La parte que separes recibe un ID nuevo.</p>' +
          campo('Unidades a separar', 'cantidad', 1, { type: 'number', req: true, attrs: 'min="1" max="' + (Number(e.cantidad) - 1) + '" step="1" inputmode="numeric"' }) +
          campo('Ubicación de esa parte', 'ubicacion', '', { list: 'lista-ubicaciones', req: true }), 'Dividir'));
      }
      break;
    case 'etiqueta':
      if (e) {
        S.seleccion.add(id);
        guardarLS(LS.sel, Array.from(S.seleccion));
        cerrarDlg();
        irA('etiquetas');
        toast(id + ' agregado a las etiquetas.');
      }
      break;
    case 'historial': if (e) await mostrarHistorial(btn, id); break;
    case 'camara': await alternarCamara(); break;
    case 'actualizar':
      try { await cargarDatos(); await sincronizarCola(); toast('Datos actualizados.'); } catch (err) { manejarError(err); }
      break;
    case 'sesion': abrirSesion(); break;
    case 'salir':
      if (!S.cola.length || confirm('Hay escaneos sin sincronizar que se perderán. ¿Cerrar la sesión igual?')) cerrarSesion('');
      break;
    case 'imprimir': imprimirEtiquetas(); break;
    case 'sel-filtrados':
      filtrar('et').forEach(x => S.seleccion.add(x.id));
      guardarLS(LS.sel, Array.from(S.seleccion));
      renderLista('et'); renderEtiquetas();
      break;
    case 'sel-ninguno':
      S.seleccion.clear();
      guardarLS(LS.sel, []);
      renderLista('et'); renderEtiquetas();
      break;
    case 'mas': S.limite[btn.dataset.k] += 150; renderLista(btn.dataset.k); break;
    case 'terminar-rel':
      S.modo = 'consulta'; S.sesion = []; S.escaneadosIds = new Set(); S.verFaltan = false;
      mostrarVacioScan(); renderRel(); enfocarScan();
      break;
    case 'ver-faltan': S.verFaltan = !S.verFaltan; renderRel(); break;
  }
}

async function mostrarHistorial(btn, id) {
  const cont = $('[data-hist]', btn.closest('.ficha'));
  if (!cont) return;
  if (!cont.hidden) { cont.hidden = true; return; }
  cont.hidden = false;
  cont.innerHTML = '<p class="suave">Cargando historial…</p>';
  try {
    const r = await api('movimientos', { id: id });
    cont.innerHTML = r.movimientos.length
      ? '<h3>Historial</h3><ul>' + r.movimientos.map(m =>
          '<li><b>' + esc(m.tipo) + '</b> ' + esc(fechaAR(m.fecha)) + ' por ' + esc(m.usuario) +
          '<small>' + esc(m.detalle) +
          (m.ubicacionAnterior !== m.ubicacionNueva ? ' (de ' + esc(m.ubicacionAnterior || 'sin ubicación') + ' a ' + esc(m.ubicacionNueva || 'sin ubicación') + ')' : '') +
          (m.segundo ? ' Segundo responsable: ' + esc(m.segundo) + '.' : '') + '</small></li>').join('') + '</ul>'
      : '<p class="suave">Este equipo todavía no tiene movimientos registrados.</p>';
  } catch (err) {
    cont.hidden = true;
    manejarError(err);
  }
}

function abrirSesion() {
  abrirDlg('<form class="dlg-cont" data-form="sesion">' +
    '<h2>Sesión</h2>' +
    campo('Tu nombre (queda en el historial)', 'usuario', S.cfg.usuario, { req: true }) +
    '<p class="suave">Datos de las ' + esc(S.actualizado ? S.actualizado : 'última carga') + '. ' + S.equipos.length + ' equipos en este dispositivo.' +
    (S.cola.length ? ' Hay ' + S.cola.length + ' escaneos pendientes de sincronizar.' : '') + '</p>' +
    '<div class="dlg-acc">' +
      '<button class="btn peligro" type="button" data-accion="salir">Cerrar sesión</button>' +
      '<button class="btn sec" type="button" data-accion="cerrar">Cancelar</button>' +
      '<button class="btn" type="submit">Guardar nombre</button>' +
    '</div></form>');
}

document.addEventListener('click', ev => {
  const btn = ev.target.closest('[data-accion]');
  if (btn) { ev.preventDefault(); accion(btn); return; }
  const modo = ev.target.closest('[data-modo]');
  if (modo) {
    S.modo = modo.dataset.modo;
    if (S.modo === 'consulta') mostrarVacioScan(); else { S.actual = null; $('#resultadoScan').innerHTML = ''; }
    renderRel(); enfocarScan();
    return;
  }
  if (S.vista === 'escanear' && !dlg.open && !ev.target.closest('input,select,textarea,button,a,label,dialog,summary')) enfocarScan();
});

document.addEventListener('input', ev => {
  const t = ev.target;
  if (!t.dataset || !t.dataset.filtro) return;
  const k = t.dataset.filtro;
  S.filtros[k][t.dataset.campo] = t.value;
  S.limite[k] = 150;
  clearTimeout(t._deb);
  t._deb = setTimeout(() => renderLista(k), t.tagName === 'INPUT' ? 120 : 0);
});

document.addEventListener('change', ev => {
  const t = ev.target;
  if (t.dataset && t.dataset.sel) {
    if (t.checked) S.seleccion.add(t.dataset.sel); else S.seleccion.delete(t.dataset.sel);
    guardarLS(LS.sel, Array.from(S.seleccion));
    renderEtiquetas();
    return;
  }
  if (t.id === 'fmtPreset') { S.fmt.preset = t.value; const p = presetActual(); if (!p.libre) { S.fmt.w = p.w; S.fmt.h = p.h; } }
  else if (t.id === 'fmtAncho') S.fmt.w = Number(t.value) || 50;
  else if (t.id === 'fmtAlto') S.fmt.h = Number(t.value) || 30;
  else if (t.id === 'fmtTexto') S.fmt.texto = t.checked;
  else return;
  guardarLS(LS.fmt, S.fmt);
  renderEtiquetas();
});

/* ───────────────────────── Navegación y arranque ───────────────────────── */

function irA(v) {
  if (['escanear', 'inventario', 'etiquetas'].indexOf(v) < 0) v = 'escanear';
  S.vista = v;
  $$('.vista').forEach(s => { s.hidden = s.id !== 'vista-' + v; });
  $$('[data-vista]').forEach(a => {
    if (a.dataset.vista === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (location.hash !== '#/' + v) history.replaceState(null, '', '#/' + v);
  if (v !== 'escanear') detenerCamara();
  if (v === 'inventario') renderLista('inv');
  if (v === 'etiquetas') { renderLista('et'); renderEtiquetas(); }
  if (v === 'escanear') setTimeout(enfocarScan, 0);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => irA(location.hash.replace(/^#\/?/, '')));

function mostrarAcceso(mensaje) {
  $('#app').hidden = true;
  $('#acceso').hidden = false;
  $('#campoUrl').hidden = !!CONFIG.apiUrl;
  const f = $('#formAcceso').elements;
  f.apiUrl.value = S.cfg.apiUrl || '';
  f.apiUrl.required = !CONFIG.apiUrl;
  f.usuario.value = S.cfg.usuario || '';
  f.pin.value = '';
  const p = $('#errorAcceso');
  p.hidden = !mensaje;
  p.textContent = mensaje || '';
  (f.usuario.value ? f.pin : f.usuario).focus();
}

function cerrarSesion(mensaje) {
  detenerCamara();
  cerrarDlg();
  S.cfg.pin = '';
  guardarLS(LS.cfg, S.cfg);
  mostrarAcceso(mensaje);
}

$('#formAcceso').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = ev.target.elements;
  const btn = $('#btnAcceso');
  const prev = { apiUrl: S.cfg.apiUrl, pin: S.cfg.pin, usuario: S.cfg.usuario };
  S.cfg.apiUrl = CONFIG.apiUrl || f.apiUrl.value.trim();
  S.cfg.pin = f.pin.value;
  S.cfg.usuario = f.usuario.value.trim();
  btn.disabled = true; btn.textContent = 'Entrando…';
  const p = $('#errorAcceso');
  p.hidden = true;
  try {
    const d = await api('cargar');
    guardarLS(LS.cfg, S.cfg);
    aplicarDatos(d);
    S.actualizado = horaCorta(); S.actualizadoMs = Date.now();
    persistir();
    entrar();
  } catch (err) {
    S.cfg = prev;
    p.hidden = false;
    p.textContent = err instanceof ErrorPin ? err.message : (err.message || 'No se pudo ingresar.');
  } finally {
    btn.disabled = false; btn.textContent = 'Entrar';
  }
});

function entrar() {
  $('#acceso').hidden = true;
  $('#app').hidden = false;
  renderTodo();
  mostrarVacioScan();
  irA(location.hash.replace(/^#\/?/, '') || 'escanear');
  sincronizarCola();
}

async function iniciar() {
  S.cfg = Object.assign({ apiUrl: '', pin: '', usuario: '' }, leerLS(LS.cfg, {}));
  if (CONFIG.apiUrl) S.cfg.apiUrl = CONFIG.apiUrl;
  S.cola = leerLS(LS.cola, []);
  S.seleccion = new Set(leerLS(LS.sel, []));
  S.fmt = Object.assign(S.fmt, leerLS(LS.fmt, {}));
  S.relUbi = leerLS(LS.ubiRel, '');
  $('#relUbi').value = S.relUbi;
  construirFiltros();

  if (!S.cfg.pin || !S.cfg.apiUrl || !S.cfg.usuario) { mostrarAcceso(); return; }

  const cache = leerLS(LS.cache, null);
  if (cache) { aplicarDatos(cache); S.actualizado = cache.actualizado || ''; }
  entrar();
  try {
    await cargarDatos();
    await sincronizarCola();
  } catch (err) {
    if (err instanceof ErrorPin) cerrarSesion(err.message);
    else { S.sinRed = true; renderSync(); }
  }
}

window.addEventListener('online', () => { S.sinRed = false; sincronizarCola(); cargarDatos().catch(() => {}); });
window.addEventListener('offline', () => { S.sinRed = true; renderSync(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.cfg.pin && Date.now() - S.actualizadoMs > 120000 && navigator.onLine !== false) {
    cargarDatos().then(sincronizarCola).catch(() => {});
  }
});

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

iniciar();
