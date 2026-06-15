let currentPage = 'dashboard';
let currentEditingTask = null;
let currentEditingGoal = null;
let tempSubtasks = [];
let selectedDateFilter = null;
let calendarViewDate = new Date();

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await db.init();
    const dateInput = document.getElementById('task-date');
    if (dateInput) dateInput.valueAsDate = new Date();
    
    await cleanupOldTasks();
    setupNavigation();
    setupEventListeners();
    await loadDashboard();
  } catch (error) {
    console.error('❌ Ошибка запуска:', error);
    document.body.innerHTML = `<h1 style="color:red; padding:40px;">Ошибка: ${error.message}</h1>`;
  }
});

// ==========================================
// 🔐 КРИПТОГРАФИЯ (Web Crypto API)
// ==========================================
async function deriveKey(pin) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw", enc.encode(pin), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  return window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("my-tracker-salt-v1"), iterations: 100000, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

async function encryptData(dataObj, pin) {
  const key = await deriveKey(pin);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv }, key, enc.encode(JSON.stringify(dataObj))
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptData(base64Str, pin) {
  try {
    const key = await deriveKey(pin);
    const combined = new Uint8Array(atob(base64Str).split('').map(c => c.charCodeAt(0)));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv }, key, data
    );
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (e) {
    throw new Error("Неверный пин-код или поврежденные данные");
  }
}

// ==========================================
// ☁️ СИНХРОНИЗАЦИЯ С JSONBIN
// ==========================================
async function uploadToCloud() {
  const pin = document.getElementById('sync-pin').value;
  const apiKey = document.getElementById('sync-api-key').value.trim();
  const statusEl = document.getElementById('sync-status');
  
  if (pin.length !== 6 || !/^\d+$/.test(pin)) {
    statusEl.textContent = '❌ Введи корректный 6-значный пин-код';
    statusEl.className = 'error'; return;
  }
  if (!apiKey) {
    statusEl.textContent = '❌ Введи Master Key с jsonbin.io';
    statusEl.className = 'error'; return;
  }

  statusEl.textContent = '🔄 Шифрование и отправка...';
  statusEl.className = 'loading';

  try {
    const data = await db.exportData();
    const encryptedData = await encryptData(JSON.parse(data), pin);
    
    // Берем ID только если он точно не "undefined" и не пустой
    let binId = localStorage.getItem('tracker_bin_id');
    if (!binId || binId === 'undefined') binId = null;
    
    let url = 'https://api.jsonbin.io/v3/b';
    let method = 'POST';

    if (binId) {
      url = `https://api.jsonbin.io/v3/b/${binId}`;
      method = 'PUT';
    }

    const response = await fetch(url, {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': apiKey,
        'X-Bin-Name': 'local-tracker-sync'
      },
      body: JSON.stringify({ data: encryptedData })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Сервер отверг запрос (${response.status}). Проверь Master Key! Детали: ${errText}`);
    }
    
    const result = await response.json();
    const newBinId = result.metadata?.id || binId;

    if (!newBinId || newBinId === 'undefined') {
      throw new Error('Сервер не вернул ID записи. Попробуй еще раз.');
    }

    document.getElementById('sync-bin-id').value = newBinId;
    localStorage.setItem('tracker_bin_id', newBinId);

    statusEl.textContent = `✅ Успешно! ID: ${newBinId}`;
    statusEl.className = 'success';
  } catch (err) {
    statusEl.textContent = '❌ Ошибка: ' + err.message;
    statusEl.className = 'error';
  }
}

async function downloadFromCloud() {
  const pin = document.getElementById('sync-pin').value;
  const apiKey = document.getElementById('sync-api-key').value.trim();
  let binId = document.getElementById('sync-bin-id').value || localStorage.getItem('tracker_bin_id');
  const statusEl = document.getElementById('sync-status');

  if (pin.length !== 6 || !/^\d+$/.test(pin)) {
    statusEl.textContent = '❌ Введи корректный 6-значный пин-код';
    statusEl.className = 'error'; return;
  }
  if (!apiKey || !binId || binId === 'undefined') {
    statusEl.textContent = '❌ Сначала выполни успешную отправку с Мака, чтобы получить Bin ID';
    statusEl.className = 'error'; return;
  }

  statusEl.textContent = '🔄 Скачивание и расшифровка...';
  statusEl.className = 'loading';

  try {
    const response = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
      headers: { 'X-Master-Key': apiKey }
    });
    
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Не найдено в облаке (${response.status}). Проверь Bin ID и Key. Детали: ${errText}`);
    }
    
    const result = await response.json();
    const encryptedData = result.record.data;
    
    const decryptedData = await decryptData(encryptedData, pin);
    await db.importData(JSON.stringify(decryptedData));
    
    statusEl.textContent = '✅ Данные успешно расшифрованы и загружены!';
    statusEl.className = 'success';
    
    setTimeout(() => {
      loadDashboard();
      statusEl.textContent = '';
    }, 2000);
  } catch (err) {
    statusEl.textContent = '❌ Ошибка: ' + err.message;
    statusEl.className = 'error';
  }
}

// ==========================================
// ОСНОВНАЯ ЛОГИКА
// ==========================================
function getPriorityBadge(priority) {
  const labels = { high: '🔴 Высокий', medium: '🟡 Средний', low: '🟢 Низкий' };
  return `<span class="priority-badge ${priority}">${labels[priority] || '🟡 Средний'}</span>`;
}

function getDaysLeftText(dueDateStr) {
  if (!dueDateStr) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const parts = dueDateStr.split('-');
  const due = new Date(parts[0], parts[1] - 1, parts[2]);
  const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24)); 
  if (diffDays === 1) return ' (Завтра)';
  if (diffDays > 1 && diffDays <= 7) return ` (Через ${diffDays} дн.)`;
  if (diffDays > 7) return ` (Через ${Math.floor(diffDays / 7)} нед.)`;
  return '';
}

window.changeCalendarMonth = function(offset) {
  calendarViewDate.setMonth(calendarViewDate.getMonth() + offset);
  renderCalendar();
}

async function cleanupOldTasks() {
  const tasks = await db.getAll('tasks');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const task of tasks) {
    if (task.status === 'done' && task.completedAt) {
      const completedDate = new Date(task.completedAt);
      completedDate.setHours(0, 0, 0, 0);
      if (completedDate < today) {
        task.status = 'deleted';
        await db.update('tasks', task);
      }
    }
  }
}

function setupNavigation() {
  // 1. Функция для показа/скрытия мобильной навигации в зависимости от ширины экрана
  function updateNavVisibility() {
    const isMobile = window.innerWidth <= 768;
    const mobileNav = document.getElementById('mobile-nav');
    if (mobileNav) {
      mobileNav.style.display = isMobile ? 'flex' : 'none';
    }
  }

  // 2. Вызываем сразу при загрузке и вешаем слушатель на изменение размера окна
  updateNavVisibility();
  window.addEventListener('resize', updateNavVisibility);

  // 3. Обработчики кликов для ВСЕХ кнопок навигации (и десктопных, и мобильных)
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      currentPage = page;
      
      // Скрываем все страницы и показываем нужную
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const targetPage = document.getElementById(page);
      if (targetPage) targetPage.classList.add('active');
      
      // Убираем активный класс со ВСЕХ кнопок во всех меню
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      
      // Добавляем активный класс нажатой кнопке И её аналогу в другом меню (чтобы они синхронизировались)
      document.querySelectorAll(`.nav-btn[data-page="${page}"]`).forEach(b => {
        b.classList.add('active');
      });
      
      // Загружаем данные для выбранной страницы
      if (page === 'dashboard') loadDashboard();
      if (page === 'tasks') loadTasks();
      if (page === 'goals') loadGoals();
      if (page === 'trash') loadTrash();
    });
  });
}

function setupEventListeners() {
  document.getElementById('add-task-btn').addEventListener('click', () => { addTask(); triggerAutoSync(); });
  document.getElementById('add-goal-btn').addEventListener('click', () => { addGoal(); triggerAutoSync(); });
  document.getElementById('export-btn').addEventListener('click', exportData);
  document.getElementById('import-btn').addEventListener('click', importData);
  document.getElementById('btn-sync-upload').addEventListener('click', uploadToCloud);
  document.getElementById('btn-sync-download').addEventListener('click', downloadFromCloud);
  
  // Восстановление настроек автосинхронизации
  const autoSync = localStorage.getItem('tracker_auto_sync') === 'true';
  document.getElementById('auto-sync-check').checked = autoSync;
  if (autoSync) {
    document.getElementById('sync-pin').value = localStorage.getItem('tracker_pin') || '';
    document.getElementById('sync-api-key').value = localStorage.getItem('tracker_api_key') || '';
  }
  const savedBinId = localStorage.getItem('tracker_bin_id');
  if (savedBinId) document.getElementById('sync-bin-id').value = savedBinId;

  document.getElementById('auto-sync-check').addEventListener('change', (e) => {
    localStorage.setItem('tracker_auto_sync', e.target.checked);
    if (e.target.checked) {
      localStorage.setItem('tracker_pin', document.getElementById('sync-pin').value);
      localStorage.setItem('tracker_api_key', document.getElementById('sync-api-key').value);
    }
  });

  document.getElementById('new-subtask-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTempSubtask(); }});
  document.getElementById('modal-new-subtask').addEventListener('keypress', (e) => { if (e.key === 'Enter') { e.preventDefault(); addModalSubtask(); }});
  document.getElementById('modal-complete-btn').addEventListener('click', () => { completeTaskFromModal(); triggerAutoSync(); });
  document.getElementById('modal-delete-btn').addEventListener('click', () => { deleteTaskFromModal(); triggerAutoSync(); });
  document.getElementById('modal-goal-delete-btn').addEventListener('click', () => { deleteGoalFromModal(); triggerAutoSync(); });
}

// ==========================================
// 🤖 УМНАЯ АВТОСИНХРОНИЗАЦИЯ (ФОНОВЫЙ РЕЖИМ)
// ==========================================
async function triggerAutoSync() {
  if (localStorage.getItem('tracker_auto_sync') !== 'true') return;
  
  const pin = localStorage.getItem('tracker_pin');
  const apiKey = localStorage.getItem('tracker_api_key');
  const binId = localStorage.getItem('tracker_bin_id');
  
  if (!pin || !apiKey || !binId) return; // Если настройки не полные, не синхронизируем

  try {
    const data = await db.exportData();
    const encryptedData = await encryptData(JSON.parse(data), pin);
    
    await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': apiKey
      },
      body: JSON.stringify({ data: encryptedData })
    });
    console.log('✅ Автосинхронизация (отправка) выполнена');
  } catch (err) {
    console.error('Ошибка автосинхронизации:', err);
  }
}

// Слушаем момент, когда пользователь открывает приложение (например, на телефоне)
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && localStorage.getItem('tracker_auto_sync') === 'true') {
    const pin = localStorage.getItem('tracker_pin');
    const apiKey = localStorage.getItem('tracker_api_key');
    const binId = localStorage.getItem('tracker_bin_id');
    
    if (pin && apiKey && binId) {
      console.log('🔄 Проверка обновлений при открытии...');
      try {
        const response = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
          headers: { 'X-Master-Key': apiKey }
        });
        if (response.ok) {
          const result = await response.json();
          const decryptedData = await decryptData(result.record.data, pin);
          await db.importData(JSON.stringify(decryptedData));
          loadDashboard(); // Обновляем экран свежими данными
          console.log('✅ Автосинхронизация (загрузка) выполнена');
        }
      } catch (err) {
        console.error('Ошибка фоновой загрузки:', err);
      }
    }
  }
});

// --- ПОДЗАДАЧИ ---
function addTempSubtask() {
  const input = document.getElementById('new-subtask-input');
  if (!input.value.trim()) return;
  tempSubtasks.push({ id: Date.now(), text: input.value.trim(), done: false });
  input.value = '';
  renderTempSubtasks();
}
function removeTempSubtask(id) {
  tempSubtasks = tempSubtasks.filter(st => st.id !== id);
  renderTempSubtasks();
}
function renderTempSubtasks() {
  const container = document.getElementById('temp-subtasks-list');
  container.innerHTML = '';
  tempSubtasks.forEach(st => {
    const div = document.createElement('div');
    div.className = 'temp-subtask-item';
    div.innerHTML = `<span>• ${st.text}</span><span class="temp-subtask-remove" onclick="removeTempSubtask(${st.id})">✕</span>`;
    container.appendChild(div);
  });
}

// --- МОДАЛКА ЗАДАЧ ---
function openTaskModal(task) {
  currentEditingTask = JSON.parse(JSON.stringify(task));
  document.getElementById('modal-task-id').value = task.id;
  document.getElementById('modal-task-title').value = task.title;
  document.getElementById('modal-task-desc').value = task.description || '';
  document.getElementById('modal-task-date').value = task.dueDate || '';
  document.getElementById('modal-task-priority').value = task.priority;
  const btn = document.getElementById('modal-complete-btn');
  btn.textContent = task.status === 'done' ? '↩️ Вернуть' : '✅ Готово';
  btn.style.background = task.status === 'done' ? '#f59e0b' : '#10b981';
  renderModalSubtasks();
  document.getElementById('task-modal-overlay').classList.add('active');
}
function closeTaskModal() {
  document.getElementById('task-modal-overlay').classList.remove('active');
  currentEditingTask = null;
}
function renderModalSubtasks() {
  const container = document.getElementById('modal-subtasks-list');
  container.innerHTML = '';
  const subs = currentEditingTask.subtasks || [];
  if (subs.length === 0) { container.innerHTML = '<div style="color:#9ca3af; font-size:13px;">Нет подзадач</div>'; return; }
  subs.forEach((st, index) => {
    const div = document.createElement('div');
    div.className = `modal-subtask-item ${st.done ? 'done' : ''}`;
    div.innerHTML = `<input type="checkbox" ${st.done ? 'checked' : ''} onchange="toggleModalSubtask(${index})"><span style="flex:1">${st.text}</span><span style="color:#ef4444; cursor:pointer;" onclick="removeModalSubtask(${index})">✕</span>`;
    container.appendChild(div);
  });
}
function toggleModalSubtask(index) { currentEditingTask.subtasks[index].done = !currentEditingTask.subtasks[index].done; renderModalSubtasks(); }
function addModalSubtask() {
  const input = document.getElementById('modal-new-subtask');
  if (!input.value.trim() || !currentEditingTask) return;
  if (!currentEditingTask.subtasks) currentEditingTask.subtasks = [];
  currentEditingTask.subtasks.push({ id: Date.now(), text: input.value.trim(), done: false });
  input.value = ''; renderModalSubtasks();
}
function removeModalSubtask(index) { currentEditingTask.subtasks.splice(index, 1); renderModalSubtasks(); }
async function saveTaskModal() {
  if (!currentEditingTask) return;
  currentEditingTask.title = document.getElementById('modal-task-title').value.trim();
  currentEditingTask.description = document.getElementById('modal-task-desc').value.trim();
  currentEditingTask.dueDate = document.getElementById('modal-task-date').value || null;
  currentEditingTask.priority = document.getElementById('modal-task-priority').value;
  await db.update('tasks', currentEditingTask);
  closeTaskModal();
  if (currentPage === 'tasks') await loadTasks(); else await loadDashboard();
}
async function completeTaskFromModal() {
  if (!currentEditingTask) return;
  currentEditingTask.status = currentEditingTask.status === 'done' ? 'todo' : 'done';
  currentEditingTask.completedAt = new Date().toISOString();
  await db.update('tasks', currentEditingTask);
  closeTaskModal();
  if (currentPage === 'tasks') await loadTasks(); else await loadDashboard();
}
async function deleteTaskFromModal() {
  if (!currentEditingTask || !confirm('Переместить задачу в корзину?')) return;
  currentEditingTask.status = 'deleted';
  await db.update('tasks', currentEditingTask);
  closeTaskModal();
  if (currentPage === 'tasks') await loadTasks(); else if (currentPage === 'trash') await loadTrash(); else await loadDashboard();
}

// --- МОДАЛКА ЦЕЛЕЙ ---
function openGoalModal(goal) {
  currentEditingGoal = JSON.parse(JSON.stringify(goal));
  document.getElementById('modal-goal-id').value = goal.id;
  document.getElementById('modal-goal-title').value = goal.title;
  document.getElementById('modal-goal-desc').value = goal.description || '';
  document.getElementById('modal-goal-category').value = goal.category || 'other';
  document.getElementById('modal-goal-date').value = goal.dueDate || '';
  document.getElementById('goal-modal-overlay').classList.add('active');
}
function closeGoalModal() {
  document.getElementById('goal-modal-overlay').classList.remove('active');
  currentEditingGoal = null;
}
async function saveGoalModal() {
  if (!currentEditingGoal) return;
  currentEditingGoal.title = document.getElementById('modal-goal-title').value.trim();
  currentEditingGoal.description = document.getElementById('modal-goal-desc').value.trim();
  currentEditingGoal.category = document.getElementById('modal-goal-category').value;
  currentEditingGoal.dueDate = document.getElementById('modal-goal-date').value || null;
  await db.update('goals', currentEditingGoal);
  closeGoalModal();
  if (currentPage === 'goals') await loadGoals(); else await loadDashboard();
}
async function deleteGoalFromModal() {
  if (!currentEditingGoal || !confirm('Удалить эту цель навсегда?')) return;
  await db.delete('goals', currentEditingGoal.id);
  closeGoalModal();
  if (currentPage === 'goals') await loadGoals(); else await loadDashboard();
}

// --- КАЛЕНДАРЬ ---
window.clearDateFilter = async function() {
  selectedDateFilter = null;
  const banner = document.getElementById('date-filter-banner');
  if (banner) banner.style.display = 'none';
  await renderCalendar();
  if (currentPage === 'tasks') await loadTasks(); else await loadDashboard();
}
window.filterByDate = async function(year, month, day) {
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  selectedDateFilter = `${year}-${mm}-${dd}`;
  const banner = document.getElementById('date-filter-banner');
  const textEl = document.getElementById('filter-date-text');
  const months = ['Января', 'Февраля', 'Марта', 'Апреля', 'Мая', 'Июня', 'Июля', 'Августа', 'Сентября', 'Октября', 'Ноября', 'Декабря'];
  if (banner) banner.style.display = 'flex';
  if (textEl) textEl.textContent = `${day} ${months[month]} ${year}`;
  await renderCalendar();
  if (currentPage === 'tasks') await loadTasks(); else await loadDashboard();
}
async function renderCalendar() {
  const tasks = await db.getAll('tasks');
  const date = calendarViewDate;
  const month = date.getMonth();
  const year = date.getFullYear();
  const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const titleEl = document.getElementById('calendar-month-year');
  if (titleEl) titleEl.textContent = `${monthNames[month]} ${year}`;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;
  const calendarDays = document.getElementById('calendar-days');
  if (!calendarDays) return;
  calendarDays.innerHTML = '';
  for (let i = 0; i < startOffset; i++) calendarDays.appendChild(document.createElement('div'));
  const todayDate = new Date();
  const today = todayDate.getDate();
  const isCurrentMonth = (todayDate.getMonth() === month && todayDate.getFullYear() === year);
  const taskDays = new Set();
  tasks.forEach(t => {
    if (t.dueDate && t.status !== 'done' && t.status !== 'deleted') {
      const parts = t.dueDate.split('-');
      if (parseInt(parts[1], 10) - 1 === month) taskDays.add(parseInt(parts[2], 10));
    }
  });
  for (let day = 1; day <= daysInMonth; day++) {
    const dayEl = document.createElement('div');
    dayEl.className = 'calendar-day';
    dayEl.textContent = day;
    if (isCurrentMonth && day === today) dayEl.classList.add('today');
    if (taskDays.has(day)) dayEl.classList.add('has-task');
    dayEl.addEventListener('click', () => {
      const currentFilter = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      if (selectedDateFilter === currentFilter) clearDateFilter();
      else filterByDate(year, month, day);
    });
    if (selectedDateFilter) {
      const parts = selectedDateFilter.split('-');
      if (parseInt(parts[2]) === day) dayEl.classList.add('selected');
    }
    calendarDays.appendChild(dayEl);
  }
}

function getDateStatus(dueDateStr) {
  if (!dueDateStr) return 'no-date';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const parts = dueDateStr.split('-');
  const due = new Date(parts[0], parts[1] - 1, parts[2]);
  if (due < today) return 'overdue';
  if (due.getTime() === today.getTime()) return 'today';
  return 'future';
}
function formatDateRu(dateStr) {
  if (!dateStr) return 'Без даты';
  const parts = dateStr.split('-');
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${parseInt(parts[2])} ${months[parseInt(parts[1]) - 1]} ${parts[0]}`;
}
const categoryLabels = { finance: '💰 Экономика', material: '📦 Вещи', personal: '🧠 Развитие', other: '📌 Остальное' };
const timeframeLabels = { week: 'Неделя', month: 'Месяц', year: 'Год', longterm: '10 лет' };

// --- ДАШБОРД ---
async function loadDashboard() {
  const tasks = await db.getAll('tasks');
  let displayTasks = tasks.filter(t => t.status !== 'done' && t.status !== 'deleted');
  if (selectedDateFilter) {
    displayTasks = displayTasks.filter(t => t.dueDate === selectedDateFilter);
  } else {
    displayTasks.sort((a, b) => {
      const statusA = getDateStatus(a.dueDate);
      const statusB = getDateStatus(b.dueDate);
      const weights = { 'overdue': 1, 'today': 2, 'future': 3, 'no-date': 4 };
      if (weights[statusA] !== weights[statusB]) return weights[statusA] - weights[statusB];
      if (statusA === 'future' && statusB === 'future') return new Date(a.dueDate) - new Date(b.dueDate);
      return 0;
    });
    displayTasks = displayTasks.slice(0, 8);
  }
  await renderCalendar();
  renderLifeGoals(await db.getAll('goals'));
  const list = document.getElementById('dashboard-tasks-list');
  list.innerHTML = '';
  if (displayTasks.length === 0) {
    list.innerHTML = `<div style="color:#9ca3af; padding: 20px; text-align:center;">${selectedDateFilter ? 'На эту дату задач нет' : 'Нет активных задач 🎉'}</div>`;
    return;
  }
  displayTasks.forEach(task => {
    const status = getDateStatus(task.dueDate);
    const item = document.createElement('div');
    item.className = `quick-task-item priority-${task.priority} ${status === 'overdue' ? 'task-overdue' : ''} ${status === 'today' ? 'task-today' : ''}`;
    let dateText = '';
    if (status === 'overdue') dateText = `⚠️ Просрочено (${formatDateRu(task.dueDate)})`;
    else if (status === 'today') dateText = `📌 Сегодня`;
    else if (status === 'future') dateText = `📅 ${formatDateRu(task.dueDate)}${getDaysLeftText(task.dueDate)}`;
    else dateText = `⏳ Без даты`;
    let subtaskProgress = (task.subtasks && task.subtasks.length > 0) ? `<div style="font-size:12px; color:#6b7280; margin-top:4px;">📋 ${task.subtasks.filter(st => st.done).length}/${task.subtasks.length}</div>` : '';
    item.innerHTML = `<div style="flex:1"><div style="font-weight: 500; margin-bottom: 4px;">${getPriorityBadge(task.priority)} ${task.title}</div><div class="task-date-meta ${status}">${dateText}</div>${subtaskProgress}</div><span style="color:#9ca3af; font-size: 18px;">✏️</span>`;
    item.addEventListener('click', () => openTaskModal(task));
    list.appendChild(item);
  });
}

// --- ЗАДАЧИ ---
async function loadTasks() {
  let tasks = await db.getAll('tasks');
  tasks = tasks.filter(t => t.status !== 'deleted');
  if (selectedDateFilter) {
    tasks = tasks.filter(t => t.dueDate === selectedDateFilter);
    renderSingleDateTaskList(tasks);
    return;
  }
  const overdue = tasks.filter(t => getDateStatus(t.dueDate) === 'overdue');
  const today = tasks.filter(t => getDateStatus(t.dueDate) === 'today');
  const future = tasks.filter(t => getDateStatus(t.dueDate) === 'future' || getDateStatus(t.dueDate) === 'no-date');
  const done = tasks.filter(t => t.status === 'done');
  const list = document.getElementById('tasks-list');
  list.innerHTML = '';
  renderTaskGroup(list, '🔥 Просроченные', 'overdue', overdue);
  renderTaskGroup(list, '📌 На сегодня', 'today', today);
  renderTaskGroup(list, '📅 Будущие', 'future', future);
  renderTaskGroup(list, '✅ Выполненные сегодня', 'done', done);
  if (overdue.length === 0 && today.length === 0 && future.length === 0 && done.length === 0) {
    list.innerHTML = '<div style="color:#9ca3af; padding: 40px; text-align:center;">Задач нет 🎉</div>';
  }
}
function renderTaskGroup(container, title, type, tasks) {
  if (tasks.length === 0) return;
  const section = document.createElement('div');
  section.className = 'group-section';
  section.innerHTML = `<div class="group-header ${type}">${title} <span style="font-weight:400; color:#9ca3af;">(${tasks.length})</span></div>`;
  const innerList = document.createElement('div');
  innerList.className = 'list';
  tasks.forEach(task => {
    const status = getDateStatus(task.dueDate);
    const item = document.createElement('div');
    item.className = `list-item priority-${task.priority} ${task.status === 'done' ? 'done' : ''} ${status === 'overdue' && task.status !== 'done' ? 'task-overdue' : ''} ${status === 'today' && task.status !== 'done' ? 'task-today' : ''}`;
    let dateHtml = '';
    if (task.dueDate) {
      let label = formatDateRu(task.dueDate);
      let metaClass = '';
      if (status === 'overdue' && task.status !== 'done') { label = '⚠️ Просрочено: ' + label; metaClass = 'overdue'; }
      else if (status === 'today' && task.status !== 'done') { label = '📌 Сегодня'; metaClass = 'today'; }
      dateHtml = `<div class="task-date-meta ${metaClass}">${label}</div>`;
    }
    let subHtml = (task.subtasks && task.subtasks.length > 0) ? `<div style="font-size:12px; color:#6b7280; margin-top:4px;">📋 ${task.subtasks.filter(s=>s.done).length}/${task.subtasks.length}</div>` : '';
    let descPreview = task.description ? `<div style="font-size:13px; color:#6b7280; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:500px;">📝 ${task.description}</div>` : '';
    item.innerHTML = `<div class="list-item-content"><div class="list-item-title">${getPriorityBadge(task.priority)} ${task.title}</div>${descPreview}${dateHtml}${subHtml}</div><button class="delete-btn" onclick="event.stopPropagation(); deleteTask(${task.id})">В корзину</button>`;
    item.addEventListener('click', () => openTaskModal(task));
    innerList.appendChild(item);
  });
  section.appendChild(innerList);
  container.appendChild(section);
}
function renderSingleDateTaskList(tasks) {
  const list = document.getElementById('tasks-list');
  list.innerHTML = '';
  if (tasks.length === 0) { list.innerHTML = '<div style="color:#9ca3af; padding: 40px; text-align:center;">На эту дату задач нет</div>'; return; }
  const section = document.createElement('div');
  section.className = 'group-section';
  section.innerHTML = `<div class="group-header today">📅 Задачи на выбранную дату</div>`;
  const innerList = document.createElement('div');
  innerList.className = 'list';
  tasks.forEach(task => {
    const item = document.createElement('div');
    item.className = `list-item priority-${task.priority} ${task.status === 'done' ? 'done' : ''}`;
    item.innerHTML = `<div class="list-item-content"><div class="list-item-title">${getPriorityBadge(task.priority)} ${task.title}</div></div><button class="delete-btn" onclick="event.stopPropagation(); deleteTask(${task.id})">В корзину</button>`;
    item.addEventListener('click', () => openTaskModal(task));
    innerList.appendChild(item);
  });
  section.appendChild(innerList);
  list.appendChild(section);
}
async function addTask() {
  const title = document.getElementById('task-title').value.trim();
  if (!title) return;
  await db.add('tasks', { title, priority: document.getElementById('task-priority').value, dueDate: document.getElementById('task-date').value || null, description: document.getElementById('task-description').value.trim(), subtasks: [...tempSubtasks], status: 'todo', createdAt: new Date().toISOString() });
  document.getElementById('task-title').value = '';
  document.getElementById('task-description').value = '';
  tempSubtasks = [];
  renderTempSubtasks();
  await loadTasks();
}
async function deleteTask(id) {
  const tasks = await db.getAll('tasks');
  const task = tasks.find(t => t.id === id);
  
  if (task) { 
    task.status = 'deleted'; 
    await db.update('tasks', task); 
    
    // === ДОБАВЛЯЕМ ЭТУ СТРОКУ ДЛЯ АВТОСИНХРОНИЗАЦИИ ===
    triggerAutoSync(); 
    // ====================================================
  }
  
  if (currentPage === 'tasks') await loadTasks(); 
  else await loadDashboard();
}

// --- КОРЗИНА ---
async function loadTrash() {
  const tasks = await db.getAll('tasks');
  const deletedTasks = tasks.filter(t => t.status === 'deleted');
  const list = document.getElementById('trash-list');
  list.innerHTML = '';
  if (deletedTasks.length === 0) { list.innerHTML = '<div style="color:#9ca3af; padding: 40px; text-align:center;">Корзина пуста 🎉</div>'; return; }
  deletedTasks.forEach(task => {
    const item = document.createElement('div');
    item.className = 'list-item trash-item';
    item.innerHTML = `<div class="list-item-content"><div class="list-item-title">${task.title}</div><div style="font-size:12px; color:#9ca3af;">Удалено: ${formatDateRu(task.createdAt)}</div></div><div class="trash-actions"><button class="btn-restore" onclick="restoreTask(${task.id})">↩️ Вернуть</button><button class="btn-delete-forever" onclick="deleteTaskForever(${task.id})">🗑 Навсегда</button></div>`;
    list.appendChild(item);
  });
}
async function restoreTask(id) {
  const tasks = await db.getAll('tasks');
  const task = tasks.find(t => t.id === id);
  if (task) { task.status = 'todo'; await db.update('tasks', task); await loadTrash(); }
}
async function deleteTaskForever(id) {
  if (!confirm('Удалить эту задачу навсегда без возможности восстановления?')) return;
  await db.delete('tasks', id);
  await loadTrash();
}

// --- ЦЕЛИ ---
async function loadGoals() {
  const goals = await db.getAll('goals');
  const container = document.getElementById('goals-list');
  container.innerHTML = '';
  const categories = [{ key: 'personal', title: '🧠 Личное развитие', color: '#1e40af' }, { key: 'finance', title: '💰 Экономические цели', color: '#065f46' }, { key: 'material', title: '📦 Цели-вещи', color: '#5b21b6' }, { key: 'other', title: '📌 Остальное', color: '#4b5563' }];
  const timeframes = [{ key: 'week', label: '📆 На неделю' }, { key: 'month', label: '🗓️ На месяц' }, { key: 'year', label: '📅 На год' }, { key: 'longterm', label: '🚀 10 лет / Жизнь' }];
  let hasAnyGoals = false;
  categories.forEach(cat => {
    const catGoals = goals.filter(g => g.category === cat.key);
    if (catGoals.length === 0) return;
    hasAnyGoals = true;
    const section = document.createElement('div');
    section.className = 'goal-group-section';
    section.innerHTML = `<div class="goal-group-title" style="color:${cat.color}">${cat.title}</div>`;
    let hasTimeframeGoals = false;
    timeframes.forEach(tf => {
      const tfGoals = catGoals.filter(g => g.timeframe === tf.key);
      if (tfGoals.length === 0) return;
      hasTimeframeGoals = true;
      tfGoals.sort((a, b) => { if (!a.dueDate) return 1; if (!b.dueDate) return -1; return new Date(a.dueDate) - new Date(b.dueDate); });
      const tfHeader = document.createElement('div');
      tfHeader.className = 'timeframe-subheader';
      tfHeader.textContent = tf.label;
      section.appendChild(tfHeader);
      const list = document.createElement('div');
      list.className = 'list';
      tfGoals.forEach(goal => {
        const dateStr = goal.dueDate ? `<span class="goal-deadline">до ${formatDateRu(goal.dueDate)}</span>` : '';
        const item = document.createElement('div');
        item.className = 'list-item';
        item.innerHTML = `<div class="list-item-content"><div class="list-item-title">${goal.title} ${dateStr}</div><div class="list-item-meta">${goal.description ? goal.description.substring(0, 100) + (goal.description.length > 100 ? '...' : '') : 'Нет описания'}</div></div><button class="delete-btn" onclick="event.stopPropagation(); deleteGoal(${goal.id})">Удалить</button>`;
        item.addEventListener('click', () => openGoalModal(goal));
        list.appendChild(item);
      });
      section.appendChild(list);
    });
    if (hasTimeframeGoals) container.appendChild(section);
  });
  if (!hasAnyGoals) container.innerHTML = '<div style="color:#9ca3af; padding: 40px; text-align:center;">Целей пока нет. Самое время добавить!</div>';
}
window.openGoalModalById = async function(id) {
  const goals = await db.getAll('goals');
  const goal = goals.find(g => g.id === id);
  if (goal) openGoalModal(goal);
}
async function addGoal() {
  const title = document.getElementById('goal-title').value.trim();
  if (!title) return;
  const category = document.getElementById('goal-category').value || 'other';
  await db.add('goals', { title, timeframe: document.getElementById('goal-timeframe').value, category: category, dueDate: document.getElementById('goal-date').value || null, description: document.getElementById('goal-description').value.trim(), createdAt: new Date().toISOString() });
  document.getElementById('goal-title').value = '';
  document.getElementById('goal-description').value = '';
  document.getElementById('goal-date').value = '';
  await loadGoals();
}
async function deleteGoal(id) {
  await db.delete('goals', id);
  await loadGoals();
}
function renderLifeGoals(goals) {
  const container = document.getElementById('life-goals-container');
  if (!container) return;
  container.innerHTML = '';
  const cats = [{key:'week', t:'📆 На неделю', c:'tf-week-card'}, {key:'month', t:'🗓️ На месяц', c:'tf-month-card'}, {key:'year', t:'📅 На год', c:'tf-year-card'}, {key:'longterm', t:'🚀 10 лет / Жизнь', c:'tf-longterm-card'}];
  cats.forEach(cat => {
    const catGoals = goals.filter(g => g.timeframe === cat.key);
    const card = document.createElement('div');
    card.className = `goal-card ${cat.c}`;
    let html = '<ul>';
    if (catGoals.length === 0) html += '<li style="color:#9ca3af; font-weight:400; border:none; padding:0; font-style:italic;">Пока нет</li>';
    else catGoals.forEach(g => { 
      const catBadge = `<span class="goal-cat-badge cat-${g.category || 'other'}">${categoryLabels[g.category] || 'Остальное'}</span>`;
      html += `<li>${catBadge} ${g.title} ${g.dueDate ? `<span class="goal-date">до ${formatDateRu(g.dueDate)}</span>` : ''}</li>`; 
    });
    html += '</ul>';
    card.innerHTML = `<h4>${cat.t}</h4>${html}`;
    container.appendChild(card);
  });
}

// --- ЭКСПОРТ/ИМПОРТ ---
async function exportData() {
  const data = await db.exportData();
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tracker-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
async function importData() {
  const file = document.getElementById('import-file').files[0];
  if (!file) { alert('Выберите файл'); return; }
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      await db.importData(e.target.result);
      alert('✅ Данные восстановлены!');
      await loadDashboard();
    } catch (err) { alert('❌ Ошибка: ' + err.message); }
  };
  reader.readAsText(file);
}