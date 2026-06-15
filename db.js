class TrackerDB {
  constructor() {
    this.dbName = 'MyTrackerDB';
    this.version = 5;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('tasks')) {
          const store = db.createObjectStore('tasks', { keyPath: 'id', autoIncrement: true });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('dueDate', 'dueDate', { unique: false });
        }
        if (!db.objectStoreNames.contains('goals')) {
          const store = db.createObjectStore('goals', { keyPath: 'id', autoIncrement: true });
          store.createIndex('timeframe', 'timeframe', { unique: false });
        }
        if (db.objectStoreNames.contains('contacts')) {
          db.deleteObjectStore('contacts');
        }
      };
    });
  }

  async add(storeName, data) {
    const tx = this.db.transaction(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(storeName).add(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getAll(storeName) {
    const tx = this.db.transaction(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async update(storeName, data) {
    const tx = this.db.transaction(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(storeName).put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(storeName, id) {
    const tx = this.db.transaction(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(storeName).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async exportData() {
    const tasks = await this.getAll('tasks');
    const goals = await this.getAll('goals');
    return JSON.stringify({ tasks, goals, exportedAt: new Date().toISOString() }, null, 2);
  }

  async importData(jsonString) {
    const data = JSON.parse(jsonString);
    const tx = this.db.transaction(['tasks', 'goals'], 'readwrite');
    tx.objectStore('tasks').clear();
    tx.objectStore('goals').clear();
    for (const task of data.tasks || []) { delete task.id; await this.add('tasks', task); }
    for (const goal of data.goals || []) { delete goal.id; await this.add('goals', goal); }
  }
}
const db = new TrackerDB();