const labels = { draft: 'Cambios pendientes de exportar y verificar', pending: 'En cola', submitting: 'Preparando trabajo', rendering: 'Produciendo', review_ready: 'Listo para revisión final', blocked: 'Bloqueado' };
const node = (tag, text) => { const el = document.createElement(tag); el.textContent = text; return el; };
const link = (text, href) => { const el = node('a', text); el.href = href; return el; };

async function openProject(item, button) {
  button.disabled = true;
  try {
    const response = await fetch('/api/course-production/projects/' + encodeURIComponent(item.id), {
      method: 'POST', headers: { 'x-course-request': '1' },
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'No se pudo preparar el proyecto');
    location.href = result.editUrl;
  } catch (error) {
    button.disabled = false;
    document.querySelector('#environment').textContent = error.message;
  }
}

function card(item) {
  const section = document.createElement('section');
  section.append(node('h2', item.title), node('small', item.course.courseName + ' · ' + item.id));
  const status = node('p', labels[item.status] || item.status); status.className = 'status'; section.append(status);
  if (item.progress) section.append(node('p', item.progress.operacion || item.progress.etiqueta || ''));
  if (item.error) section.append(node('p', item.error));
  if (item.projectError) section.append(node('p', item.projectError));
  const actions = node('p', ''); actions.className = 'links';
  if (item.editUrl) actions.append(link('Editar proyecto', item.editUrl));
  else {
    const edit = node('button', 'Editar proyecto'); edit.disabled = !!item.projectError;
    edit.onclick = () => openProject(item, edit); actions.append(edit);
  }
  if (item.status === 'review_ready' && item.videoUrl) {
    actions.append(link('Revisar edición', item.editUrl), link('Ver video', item.videoUrl));
    section.append(node('small', 'Comprobación técnica completada. Revisa pronunciación, subtítulos y edición. ' + (item.warnings || []).join(' ')));
  }
  section.append(actions); return section;
}

async function update() {
  try {
    const response = await fetch('/api/course-production');
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Consulta fallida');
    const queue = data.productionEnabled ? 'Cola automática activa. ' : 'Cola automática pausada: puedes editar sin generar videos. ';
    const environment = data.environment?.ok ? 'Entorno local disponible.' : 'Limitaciones del entorno: ' + (data.environment?.reasons || ['No se pudo comprobar el entorno']).join(' ');
    document.querySelector('#environment').textContent = queue + (data.startupError ? 'Error de producción: ' + data.startupError + '. ' : '') + environment;
    document.querySelector('#items').replaceChildren(...data.entries.map(card));
  } catch (error) {
    document.querySelector('#environment').textContent = 'No se pudo consultar la cola: ' + error.message;
  }
}
await update();
setInterval(update, 15000);
