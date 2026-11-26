import { h, icon, put, downloadFile } from '../utils/dom.js';
import { formatDate } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { persistenceStatus, requestPersistence, storageEstimate, openDB } from '../database/db.js';
import { STORES, DB_VERSION, APP_VERSION, DB_NAME } from '../database/schema.js';
import { buildBackup, parseBackupText, transactionsToCSV, encryptBackup, backupFileName, MAX_BACKUP_BYTES } from '../services/backup.js';
import { auditData } from '../services/integrity.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { field, segmented } from '../components/fields.js';

export const STORE_LABEL = { transactions: 'lançamentos', categories: 'categorias', blocks: 'blocos', accounts: 'contas e cartões', recurrences: 'recorrências', installmentPlans: 'parcelamentos', budgets: 'orçamentos', investments: 'investimentos', investmentEvents: 'registros de investimento', goals: 'metas' };
export const REMINDER_OPTIONS = [[0, 'Sem lembretes'], [7, 'A cada 7 dias'], [15, 'A cada 15 dias'], [30, 'Mensalmente']];

const fmtDateTime = (ms) => new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const countsText = (counts) => Object.entries(STORE_LABEL).map(([s, l]) => [l, counts[s] || 0]).filter(([, n]) => n).map(([l, n]) => `${n} ${l}`).join(', ');

/**
 * Gera o arquivo de backup a partir de uma leitura consistente (uma única
 * transação do IndexedDB). Só informa sucesso depois que o arquivo foi
 * montado e entregue ao navegador; deixa claro que salvar fora do navegador
 * é responsabilidade do usuário.
 */
export async function exportBackup({ password = null } = {}) {
  let data;
  try { data = await repo.readConsistent(); } catch (err) { toastError(err); toast('Não foi possível ler os dados para o backup. Nenhum arquivo foi gerado.', { tone: 'error' }); return false; }
  let backup;
  try { backup = await buildBackup(data); } catch (err) { toastError(err); toast('Não foi possível gerar o backup neste navegador. Nenhum arquivo foi gerado.', { tone: 'error' }); return false; }
  const issues = auditData(data).filter((i) => i.severity === 'error').length;
  const now = new Date();
  let content = backup;
  if (password) {
    try { content = await encryptBackup(backup, password); } catch (err) { toastError(err); return false; }
  }
  downloadFile(backupFileName(now, { encrypted: Boolean(password) }), JSON.stringify(content, null, password ? 0 : 1), 'application/json');
  await repo.recordBackup({ id: backup.backupId, encrypted: Boolean(password), counts: backup.counts }).catch(() => {});
  toast(`Arquivo de backup gerado${password ? ' (protegido por senha)' : ''}. Guarde-o fora deste navegador.${issues ? ` Atenção: ${issues} inconsistência(s) — veja Integridade.` : ''}`, { tone: 'success', timeout: 7000 });
  return true;
}

export function openExportDialog() {
  let mode = 'plain';
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, placeholder: 'Mínimo de 8 caracteres' });
  const pass2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Repita a senha' });
  const protectBox = h('div', { class: 'stack', hidden: true },
    h('div', { class: 'form-grid' }, field('Senha', pass), field('Confirmar senha', pass2)),
    h('p', { class: 'note is-warn' }, icon('alert', 'icon-sm'), 'Se você perder a senha, não será possível recuperar este backup. O Fluxo não guarda a senha.'));
  const seg = segmented({ label: 'Tipo de arquivo', value: mode, options: [{ value: 'plain', label: 'JSON comum' }, { value: 'protected', label: 'Protegido por senha' }], onChange: (v) => { mode = v; protectBox.hidden = v !== 'protected'; } });
  const go = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    if (mode === 'protected') {
      if (pass.value.length < 8) { toast('Use uma senha com pelo menos 8 caracteres.', { tone: 'error' }); return; }
      if (pass.value !== pass2.value) { toast('As senhas não conferem.', { tone: 'error' }); return; }
    }
    go.classList.add('is-busy');
    const ok = await exportBackup({ password: mode === 'protected' ? pass.value : null });
    go.classList.remove('is-busy');
    if (ok) m.close();
  } }, 'Gerar arquivo');
  const m = openModal({ title: 'Exportar backup completo', size: 'sm', body: h('div', { class: 'stack-lg' },
    h('p', { class: 'muted small' }, 'Inclui lançamentos, contas, cartões, categorias, blocos, recorrências, parcelamentos, investimentos, metas, preferências e a personalização das telas.'),
    seg, protectBox,
    h('p', { class: 'note' }, icon('info', 'icon-sm'), 'O JSON comum pode ser lido por qualquer pessoa que tenha o arquivo. Não publique backups no GitHub nem em serviços públicos.')),
  footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), go] });
}

export async function exportCSV() {
  await repo.whenFullyLoaded();
  const maps = { categories: new Map(repo.list('categories').map((c) => [c.id, c])), blocks: new Map(repo.list('blocks').map((c) => [c.id, c])), accounts: new Map(repo.list('accounts').map((c) => [c.id, c])) };
  downloadFile(backupFileName(new Date()).replace('backup', 'lancamentos').replace('.json', '.csv'), transactionsToCSV(repo.list('transactions'), maps), 'text/csv;charset=utf-8');
  toast('CSV gerado', { tone: 'success' });
}

function askPassword() {
  return new Promise((resolve) => {
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    let value = null;
    const ok = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { value = pass.value; m.close(); } }, 'Abrir');
    pass.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ok.click(); } });
    const m = openModal({ title: 'Backup protegido', size: 'sm', body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Informe a senha usada ao gerar o arquivo.'), field('Senha', pass)),
      footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), ok], onClose: () => resolve(value) });
  });
}

function showInvalid(errors) {
  const m = openModal({ title: 'Backup inválido', size: 'sm', body: h('div', { class: 'stack' },
    h('p', null, 'Nenhum dado foi alterado. Problemas encontrados:'),
    h('ul', { class: 'issues' }, ...errors.map((e) => h('li', null, e)))),
  footer: [h('span', { class: 'grow' }), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => m.close() }, 'Entendi')] });
}

/**
 * Restauração: ler → validar tudo (tamanho, estrutura, versão, tipos, ids,
 * relacionamentos, duplicidades, checksum) → prévia → confirmação explícita →
 * substituição atômica com snapshot do estado anterior. A base atual só é
 * tocada depois de todas as validações.
 */
export async function importFile(file) {
  if (file.size > MAX_BACKUP_BYTES) { showInvalid(['Arquivo grande demais para ser um backup.']); return; }
  let text;
  try { text = await file.text(); } catch { showInvalid(['Não foi possível ler o arquivo.']); return; }
  let res = await parseBackupText(text);
  if (!res.ok && res.needsPassword) {
    const password = await askPassword();
    if (!password) return;
    res = await parseBackupText(text, { password });
  }
  if (!res.ok) { showInvalid(res.errors); return; }
  await previewAndRestore(res);
}

async function previewAndRestore(res, { source = 'arquivo' } = {}) {
  await repo.whenFullyLoaded();
  const current = Object.fromEntries(Object.keys(STORE_LABEL).map((s) => [s, repo.list(s).length]));
  const keepCopy = h('input', { type: 'checkbox', checked: !repo.isEmpty() });
  const row = (label, value) => h('div', { class: 'kv' }, h('span', { class: 'kv-label' }, label), h('span', { class: 'kv-value' }, value));
  const details = h('div', { class: 'stack small' },
    h('div', { class: 'kvs' },
      res.createdAt ? row('Gerado em', fmtDateTime(Date.parse(res.createdAt))) : null,
      row('Versão', res.legacy ? 'Guia Financeiro 1.0 / Fluxo 2.0 (formato legado)' : `Fluxo ${res.appVersion || '—'}`),
      row('Integridade', res.checksum === 'ok' ? 'SHA-256 conferido' : 'sem checksum (formato legado)'),
      res.encrypted ? row('Proteção', 'arquivo protegido por senha') : null,
      row('Lançamentos', String(res.counts.transactions || 0)),
      row('Contas e cartões', String(res.counts.accounts || 0)),
      row('Metas', String(res.counts.goals || 0)),
      row('Período', res.period ? `${formatDate(res.period.from)} a ${formatDate(res.period.to)}` : 'sem lançamentos')),
    h('div', { class: 'impact' },
      h('div', null, h('div', { class: 'faint' }, 'Será restaurado'), h('div', null, countsText(res.counts) || 'nenhum registro')),
      h('div', null, h('div', { class: 'faint' }, 'Será substituído'), h('div', null, countsText(current) || 'base vazia'))),
    res.warnings?.length ? h('ul', { class: 'issues is-warn' }, ...res.warnings.map((w) => h('li', null, w))) : null,
    h('label', { class: 'check' }, keepCopy, h('span', null, 'Baixar um backup dos dados atuais antes de restaurar (recomendado)')),
    h('p', { class: 'faint' }, 'Um snapshot interno do estado atual também é guardado neste navegador. Ele não substitui um backup externo: limpar os dados do site apaga os dois.'));
  const ok = await confirmDialog({ title: `Restaurar backup (${source})?`, message: 'A base atual será substituída em uma única operação. Se qualquer etapa falhar, nada é alterado.', confirmLabel: 'Restaurar', danger: true, details });
  if (!ok) return;
  try {
    if (keepCopy.checked) { const saved = await exportBackup(); if (!saved) return; }
    await repo.importData(res.backup.data);
    toast('Backup restaurado e conferido', { tone: 'success' });
  } catch (err) {
    toastError(err);
    toast('A restauração falhou; os dados anteriores foram preservados.', { tone: 'error' });
  }
}

export async function restoreSnapshot(snap) {
  let data;
  try { data = JSON.parse(snap.data); } catch { showInvalid(['Snapshot interno danificado.']); return; }
  const backup = await buildBackup(data, new Date(snap.createdAt));
  const res = await parseBackupText(JSON.stringify(backup));
  if (!res.ok) { showInvalid(res.errors); return; }
  await previewAndRestore(res, { source: `snapshot de ${fmtDateTime(snap.createdAt)}` });
}

export async function wipe() {
  const input = h('input', { class: 'input', placeholder: 'Digite APAGAR', autocomplete: 'off' });
  const go = h('button', { class: 'btn btn-danger btn-solid', type: 'button', disabled: true, onclick: async () => {
    go.classList.add('is-busy');
    try { await repo.wipeAll(); m.close(); toast('Todos os dados financeiros foram apagados. Um snapshot interno do estado anterior foi guardado.'); location.hash = '#/visao-geral'; }
    catch (err) { toastError(err); } finally { go.classList.remove('is-busy'); }
  } }, 'Apagar dados financeiros');
  input.addEventListener('input', () => { go.disabled = input.value.trim().toUpperCase() !== 'APAGAR'; });
  const m = openModal({ title: 'Apagar todos os dados financeiros?', size: 'sm', body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Remove lançamentos, contas, metas e demais registros deste navegador. Exporte um backup antes.'),
    h('button', { class: 'btn', type: 'button', onclick: openExportDialog }, icon('download', 'icon-sm'), 'Exportar backup agora'), field('Confirmação', input)),
  footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), go] });
}

/** Seção "Dados e backup". */
export function dataPanel() {
  const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: (ev) => { const f = ev.target.files[0]; ev.target.value = ''; if (f) importFile(f); } });
  const last = repo.lastBackup();
  const prefs = repo.prefs();
  const reminder = segmented({ label: 'Lembrete de backup', size: 'segmented-sm', value: String(prefs.backupReminderDays ?? 30), options: REMINDER_OPTIONS.map(([v, l]) => ({ value: String(v), label: l })),
    onChange: async (v) => { try { await repo.setPrefs({ backupReminderDays: Number(v) }); toast('Lembrete atualizado'); } catch (err) { toastError(err); } } });
  return h('div', { class: 'stack-lg' },
    h('div', { class: 'notice' }, icon('alert', 'icon-sm'), h('p', null, 'Seus dados ficam só neste navegador e não são sincronizados entre dispositivos. Limpar os dados do site, usar navegação privada ou trocar de navegador pode apagá-los. O IndexedDB não é criptografado: guarde backups fora do navegador, em local seguro e privado.')),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: openExportDialog }, icon('download', 'icon-sm'), 'Exportar backup completo'),
      h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, icon('upload', 'icon-sm'), 'Restaurar backup'),
      h('button', { class: 'btn', type: 'button', onclick: exportCSV }, icon('download', 'icon-sm'), 'Lançamentos em CSV'), file),
    h('div', { class: 'settings-row' }, h('div', { class: 'label' }, h('strong', null, 'Último backup gerado'), h('span', null, last ? `${fmtDateTime(last.at)}${last.encrypted ? ' · protegido por senha' : ''}. Confirme que o arquivo está guardado fora do navegador.` : 'Nenhum backup gerado neste navegador.'))),
    h('div', { class: 'settings-row' }, h('div', { class: 'label' }, h('strong', null, 'Lembrete'), h('span', null, 'Aviso discreto na visão geral quando o último backup estiver antigo.')), reminder));
}

/** Seção "Diagnóstico de armazenamento". */
export function diagnosticsPanel() {
  const out = h('div', { class: 'kvs' });
  const snaps = h('div', { class: 'stack' });
  const kv = (label, value, cls = '') => h('div', { class: `kv kv-wrap ${cls}` }, h('span', { class: 'kv-label' }, label), h('span', { class: 'kv-value' }, value));
  (async () => {
    const st = repo.dbState();
    let version = '—';
    try { version = String((await openDB()).version); } catch { version = 'indisponível'; }
    const [persist, est] = await Promise.all([persistenceStatus(), storageEstimate()]);
    const counts = Object.fromEntries(STORES.map((s) => [s, repo.list(s).length]));
    let issues = '—';
    try { const data = await repo.readConsistent(); const all = auditData(data); issues = all.length ? `${all.length} (veja Integridade)` : 'nenhuma'; } catch { /* informado no estado */ }
    const last = repo.lastBackup();
    put(out,
      kv('Estado do banco', st.closed ? 'fechado (recarregue a página)' : st.locked ? 'bloqueado por restauração em outra aba' : st.fullyLoaded ? 'disponível' : 'carregando histórico…', st.closed || st.locked ? 'warn' : ''),
      kv('Banco local', `${DB_NAME} · esquema v${version}${Number(version) === DB_VERSION ? '' : ` (esperado v${DB_VERSION})`}`),
      kv('Versão do Fluxo', APP_VERSION),
      kv('Registros', countsText(counts) || 'nenhum', 'kv-wrap'),
      kv('Último backup gerado', last ? fmtDateTime(last.at) : 'nenhum', last ? '' : 'warn'),
      kv('Armazenamento usado', est?.usage != null ? `${(est.usage / 1048576).toFixed(1).replace('.', ',')} MB${est.quota ? ` de ~${Math.round(est.quota / 1048576).toLocaleString('pt-BR')} MB disponíveis` : ''}` : 'não informado pelo navegador'),
      kv('Armazenamento persistente', { granted: 'concedido', denied: 'não concedido (o navegador pode liberar espaço apagando dados)', unsupported: 'não informado pelo navegador' }[persist], persist === 'denied' ? 'warn' : ''),
      kv('Inconsistências detectadas', issues));
    if (persist === 'denied') out.append(h('div', { class: 'kv-action' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { const r = await requestPersistence(); toast(r === 'granted' ? 'Armazenamento persistente concedido' : 'O navegador não concedeu agora; ele pode decidir com base no uso.'); } }, 'Solicitar armazenamento persistente')));
    let list = [];
    try { list = await repo.listSnapshots(); } catch { /* sem snapshots */ }
    put(snaps, h('strong', { class: 'small' }, 'Snapshots internos'),
      h('p', { class: 'faint small' }, 'Cópias automáticas do estado anterior a restaurações e limpezas (as 3 mais recentes). Ficam neste mesmo navegador: não substituem backups externos.'),
      list.length ? h('div', { class: 'kvs' }, ...list.map((sn) => h('div', { class: 'kv' },
        h('span', { class: 'kv-label' }, `${fmtDateTime(sn.createdAt)} · antes de ${sn.reason === 'wipe' ? 'apagar tudo' : 'uma restauração'}`, h('span', { class: 'faint' }, ` · ${sn.counts?.transactions ?? 0} lançamentos`)),
        h('span', { class: 'kv-value' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => restoreSnapshot(sn) }, 'Restaurar este estado'))))) : h('p', { class: 'faint small' }, 'Nenhum snapshot guardado.'));
  })().catch((err) => put(out, kv('Diagnóstico', `não disponível: ${err.message}`, 'warn')));
  return h('div', { class: 'stack-lg' }, out, snaps);
}

export function dangerPanel() {
  return h('div', { class: 'danger-zone' }, h('div', null, h('strong', null, 'Apagar todos os dados financeiros'), h('p', { class: 'faint small' }, 'Remove os registros deste navegador. A aparência e a personalização não são afetadas.')),
    h('button', { class: 'btn btn-danger', type: 'button', onclick: wipe }, 'Apagar dados'));
}

/** Lembrete discreto (visão geral) quando o último backup está antigo. */
export function backupReminder() {
  const days = repo.prefs().backupReminderDays ?? 30;
  if (!days || repo.list('transactions').length === 0) return null;
  const last = repo.lastBackup();
  let snooze = 0;
  try { snooze = Number(localStorage.getItem('gf.backupSnooze') || 0); } catch { /* opcional */ }
  if (Date.now() < snooze) return null;
  const age = last ? Math.floor((Date.now() - last.at) / 86400000) : null;
  if (age != null && age < days) return null;
  const bar = h('div', { class: 'reminder', role: 'status' }, icon('database', 'icon-sm'),
    h('span', { class: 'grow' }, age == null ? 'Você ainda não gerou um backup dos seus dados.' : `Seu último backup foi gerado há ${age} dias.`),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: openExportDialog }, 'Gerar backup'),
    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { try { localStorage.setItem('gf.backupSnooze', String(Date.now() + 3 * 86400000)); } catch { /* opcional */ } bar.remove(); } }, 'Lembrar depois'));
  return bar;
}

export { APP_VERSION, confirmDialog };
