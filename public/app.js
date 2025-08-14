class FileManager {
  constructor() {
    this.currentPath = "/";
    this.currentFile = null;
    this.openFiles = new Map();
    this.activeTab = null;
    this.descriptions = {};
    this.selectedItem = null;
    this.renameData = null;

    this.folderCache = new Map();
    this.expandedFolders = new Set();

    this.init();
  }

  async init() {
    this.bindEvents();
    await this.refreshTreeAndDescriptions();
    UI.showEmptyState();
  }

  // ========================= API =========================

  async apiGet(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return res.json();
  }

  async apiSend(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
    return res.json().catch(() => ({}));
  }

  async apiDownload(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
    const blob = await res.blob();
    const downloadUrl = URL.createObjectURL(blob);
    return downloadUrl;
  }

  // ========================= ИНИЦИАЛИЗАЦИЯ UI =========================

  bindEvents() {
    UI.byId("create-folder-btn").addEventListener("click", () =>
      this.showCreateFolderModal()
    );
    UI.byId("upload-file-btn").addEventListener("click", () =>
      UI.byId("file-input").click()
    );
    UI.byId("file-input").addEventListener("change", (e) =>
      this.uploadFiles(e)
    );
    UI.byId("refresh-tree-btn").addEventListener("click", () =>
      this.refreshTreeAndDescriptions()
    );
    UI.byId("rename-item-btn").addEventListener("click", () =>
      this.renameSelectedItem()
    );
    UI.byId("delete-item-btn").addEventListener("click", () =>
      this.deleteSelectedItem()
    );

    UI.byId("confirm-create-folder").addEventListener("click", () =>
      this.createFolder()
    );
    UI.byId("cancel-create-folder").addEventListener("click", () =>
      UI.hideModal("create-folder-modal")
    );
    UI.byId("confirm-rename").addEventListener("click", () =>
      this.confirmRename()
    );
    UI.byId("cancel-rename").addEventListener("click", () =>
      UI.hideModal("rename-modal")
    );

    UI.byId("save-description-btn").addEventListener("click", () =>
      this.saveDescription()
    );
    UI.byId("download-file-btn").addEventListener("click", () =>
      this.downloadFile()
    );

    document.querySelectorAll(".modal").forEach((modal) => {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.classList.remove("active");
      });
    });
  }

  // ========================= УТИЛИТЫ ДЛЯ ПУТЕЙ =========================

  normalizePath(p) {
    if (p === "/") return p;
    if (!p) return "/";
    let norm = p.replace(/^\/+|\/+$/g, "");
    if (norm === "") return "/";
    return norm.startsWith("/") ? norm : "/" + norm;
  }

  // Получение родительского пути
  getParentPath(path) {
    const norm = this.normalizePath(path);
    if (norm === "/") return null;

    const parts = norm.split("/").filter(Boolean);
    parts.pop(); // Удаляем последний элемент
    return parts.length ? "/" + parts.join("/") : "/";
  }

  // Получение имени файла/папки из пути
  getNameFromPath(path) {
    const norm = this.normalizePath(path);
    const parts = norm.split("/").filter(Boolean);
    return parts.pop() || "";
  }

  // ========================= КЭШ + ПОДГРУЗКА =========================

  // Инвалидируем кэш для переданного пути и всех его потомков
  invalidateLoadedFolders(path) {
    const norm = this.normalizePath(path);
    if (norm === "/") {
      // если инвалидируем корень - очистим всё
      this.folderCache.clear();
      return;
    }

    // const prefix = norm === "/" ? "/" : norm + "/";
    const prefix = norm + "/";
    for (const key of this.folderCache.keys()) {
      if (key === norm || key.startsWith(prefix)) {
        this.folderCache.delete(key);
      }
    }
  }

  // Рендерит детей из кэша (если есть), не делает сетевых запросов
  renderChildrenFromCache(folderPath, container, level = 0) {
    const norm = this.normalizePath(folderPath);
    const children = this.folderCache.get(norm) || [];
    container.innerHTML = "";
    children.forEach((item) => {
      if (item.type === "folder") this.renderFolder(item, container, level + 1);
      else this.renderFile(item, container, level + 1);
    });
  }

  // Загружает детей с сервера, заполняет кэш и рендерит
  async loadFolderChildren(folderPath, container, level = 0) {
    if (!container) return;
    const norm = this.normalizePath(folderPath);
    if (this.folderCache.has(norm)) {
      this.renderChildrenFromCache(norm, container, level);
      return;
    }

    try {
      if (!container.children.length) {
        container.innerHTML = '<div class="loading">Загрузка...</div>';
      }

      const folder = await this.apiGet(
        `/api/tree?path=${encodeURIComponent(norm)}`
      );

      // нормализация дочерних путей и запись в кэш
      const children = (folder.children || []).map((c) => ({
        ...c,
        path: this.normalizePath(c.path),
      }));
      this.folderCache.set(norm, children);

      // рендер из кэша (чтобы единообразно работать)
      this.renderChildrenFromCache(norm, container, level);
    } catch (err) {
      console.error("Ошибка загрузки папки:", err);
      container.innerHTML = '<div class="error">Ошибка загрузки</div>';
    }
  }

  async refreshTreeAndDescriptions() {
    await Promise.all([this.loadTree(), this.loadDescriptions()]);
  }

  // ========================= ВОССТАНОВЛЕНИЕ И ПОДГРУЗКА ДЕРЕВА =========================

  // возвращает массив предковых путей (в порядке от корня к ближайшему)
  _getAncestorPaths(path) {
    const normalized = this.normalizePath(path);
    if (normalized === "/") return [];

    const parts = normalized.split("/").filter(Boolean);
    const ancestors = [];
    let current = "";

    // Генерируем пути предков без последнего элемента
    for (let i = 0; i < parts.length - 1; i++) {
      current += (current ? "/" : "/") + parts[i];
      ancestors.push(current);
    }

    return ancestors;
  }

  // Убедиться, что все предки targetPath развернуты и загружены (по порядку)
  async ensureAncestorsExpanded(targetPath) {
    const ancestors = this._getAncestorPaths(targetPath);
    for (const anc of ancestors) {
      const header = document.querySelector(
        `.folder-header[data-path="${anc}"]`
      );
      const container = header?.nextElementSibling;
      if (!header) continue;
      // Разворачиваем визуально
      this.expandedFolders.add(anc);
      header.dataset.expanded = "true";
      if (!this.folderCache.has(anc) && header.dataset.hasChildren === "true") {
        await this.loadFolderChildren(
          anc,
          container,
          parseInt(header.dataset.level || "0")
        );
      }
    }
  }

  restoreExpandedChildren(parentPath) {
    const normParent = this.normalizePath(parentPath);
    const prefix = normParent !== "/" ? normParent + "/" : "/";

    Array.from(this.expandedFolders)
      .filter((p) => p.startsWith(prefix) && p !== normParent)
      .sort((a, b) => a.split("/").length - b.split("/").length)
      .forEach((path) => {
        const header = document.querySelector(
          `.folder-header[data-path="${path}"]`
        );
        const container = header?.nextElementSibling;
        if (header && container && header.dataset.hasChildren === "true") {
          this.loadFolderChildren(
            path,
            container,
            parseInt(header.dataset.level || "0")
          ).then(() => {
            // После загрузки рекурсивно восстанавливаем вложенные
            this.restoreExpandedChildren(path);
          });
        }
      });

    // Восстанавливаем класс active для выбранной папки/файла, если она находится внутри parentPath
    if (this.selectedItem) {
      const selectedPath = this.normalizePath(this.selectedItem.path);
      if (selectedPath === normParent || selectedPath.startsWith(prefix)) {
        const el = document.querySelector(`[data-path="${selectedPath}"]`);
        if (el) {
          UI.clearActiveItems();
          el.classList.add("active");
        }
      }
    }
  }

  async loadTree() {
    try {
      // Сохраняем текущее состояние раскрытых путей
      const prevExpanded = Array.from(
        document.querySelectorAll(".folder-header[data-expanded='true']")
      ).map((el) => el.dataset.path);

      // Переносим в наше хранилище состояния
      this.expandedFolders = new Set(prevExpanded);
      const prevSelected = this.selectedItem?.path || this.currentPath || null;

      // Получаем дерево (корневой уровень)
      const tree = await this.apiGet("/api/tree");

      // Нормализуем пути в корне
      if (tree && tree.children) {
        // кэшируем детей корня
        const normalizedChildren = tree.children.map((c) => ({
          ...c,
          path: this.normalizePath(c.path),
        }));
        this.folderCache.set(this.normalizePath(tree.path), normalizedChildren);
      }

      this.renderTree({...tree, path: this.normalizePath(tree.path)});

      // Восстанавливаем развёрнутые пути (по порядку, родители первыми)
      prevExpanded.sort(
        (a, b) =>
          (a ? a.split("/").filter(Boolean).length : 0) -
          (b ? b.split("/").filter(Boolean).length : 0)
      );

      for (const path of prevExpanded) {
        const header = document.querySelector(
          `.folder-header[data-path="${path}"]`
        );
        const container = header?.nextElementSibling;
        if (!header || !container) continue;
        // разметка уже есть из renderFolder по expandedFolders
        if (
          !this.folderCache.has(path) &&
          header.dataset.hasChildren === "true"
        ) {
          await this.loadFolderChildren(
            path,
            container,
            parseInt(header.dataset.level || "0")
          );
        }
      }

      // восстановление выделения
      if (prevSelected) {
        const el = document.querySelector(`[data-path="${prevSelected}"]`);
        if (el) {
          const type =
            el.dataset.type ||
            (el.classList.contains("file") ? "file" : "folder");
          this.setSelectedItem(prevSelected, type);
        } else {
          await this.ensureAncestorsExpanded(prevSelected);
          const el2 = document.querySelector(`[data-path="${prevSelected}"]`);
          if (el2)
            this.setSelectedItem(prevSelected, el2.dataset.type || "file");
        }
      }

      if (this.expandedFolders.size > 0) this.restoreExpandedChildren("/");
    } catch (e) {
      console.error("Ошибка загрузки дерева:", e);
      UI.byId("file-tree").innerHTML =
        '<div class="error">Ошибка загрузки</div>';
    }
  }

  async loadDescriptions() {
    try {
      const response = await this.apiGet("/api/description");
      this.descriptions = response.description;
    } catch (e) {
      console.error("Ошибка загрузки описаний:", e);
    }
  }

  // ========================= РЕНДЕР =========================

  renderTree(node) {
    const treeContainer = UI.byId("file-tree");
    treeContainer.innerHTML = "";
    if (node.type === "folder") this.renderFolder(node, treeContainer, 0);
    else this.renderFile(node, treeContainer, 0);
  }

  renderFolder(folder, parent, level) {
    console.log("cache:", this.folderCache);
    const folderElement = document.createElement("div");
    folderElement.className = "folder";
    folderElement.style.setProperty("--pl", `${20 + level * 24}px`);

    const folderHeader = document.createElement("div");
    folderHeader.className = "folder-header tree-item";

    // Нормализуем путь и кладём в data-path
    const normPath = this.normalizePath(folder.path);
    folderHeader.dataset.path = normPath;
    folderHeader.dataset.type = "folder";
    folderHeader.dataset.level = level;

    // Вычисляем наличие детей: приоритетно берем информацию от API, иначе смотрим в кэше
    const cachedChildren = this.folderCache.get(normPath);
    const hasChildrenFlag =
      folder.hasChildren ||
      (folder.children && folder.children.length > 0) ||
      (cachedChildren && cachedChildren.length > 0);
    folderHeader.dataset.hasChildren = hasChildrenFlag ? "true" : "false";

    // состояние раскрытости - читаем из expandedFolders
    const isExpanded = this.expandedFolders.has(normPath);
    folderHeader.dataset.expanded = isExpanded ? "true" : "false";

    const toggleIconBtn = document.createElement("button");
    toggleIconBtn.className = "toggle-icon-btn";
    folderHeader.appendChild(toggleIconBtn);

    const folderIcon = document.createElement("span");
    folderIcon.className = "folder-icon";
    folderIcon.ariaHidden = true;
    folderHeader.appendChild(folderIcon);

    const folderName = document.createElement("span");
    folderName.className = "folder-name";
    folderName.textContent = folder.name;
    folderHeader.appendChild(folderName);

    folderElement.appendChild(folderHeader);

    const childrenContainer = document.createElement("div");
    childrenContainer.className = "folder-children";

    // Если API вернул детей прямо при первой рендеринге - кэшируем их
    if (folder.children && folder.children.length) {
      const normalizedChildren = folder.children.map((c) => ({
        ...c,
        path: this.normalizePath(c.path),
      }));
      this.folderCache.set(normPath, normalizedChildren);

      // отрисуем сразу
      normalizedChildren.forEach((item) =>
        item.type === "folder"
          ? this.renderFolder(item, childrenContainer, level + 1)
          : this.renderFile(item, childrenContainer, level + 1)
      );
    } else if (cachedChildren && cachedChildren.length) {
      // отрисуем уже закэшированных детей
      cachedChildren.forEach((item) =>
        item.type === "folder"
          ? this.renderFolder(item, childrenContainer, level + 1)
          : this.renderFile(item, childrenContainer, level + 1)
      );
    }

    toggleIconBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleFolder(normPath, childrenContainer);
    });

    folderHeader.addEventListener("click", () => {
      this.setSelectedItem(normPath, "folder");
      this.selectFolder(normPath);
    });

    folderElement.appendChild(folderHeader);
    folderElement.appendChild(childrenContainer);
    parent.appendChild(folderElement);
  }

  renderFile(file, parent, level) {
    const fileEl = document.createElement("div");
    fileEl.className = "tree-item file";
    const normPath = this.normalizePath(file.path);
    fileEl.dataset.path = normPath;
    fileEl.dataset.type = "file";
    fileEl.style.setProperty(
      "--pl",
      `${20 + level * 20 + (level < 1 ? 0 : level * 4)}px`
    );

    const description = this.descriptions[normPath] || "";

    const fileIcon = document.createElement("span");
    fileIcon.className = "icon";
    fileIcon.ariaHidden = true;
    fileEl.appendChild(fileIcon);

    const fileName = document.createElement("span");
    fileName.className = "name";
    fileName.textContent = file.name;
    fileEl.appendChild(fileName);

    if (description) {
      const fileDescription = document.createElement("div");
      fileDescription.className = "tooltip";
      fileDescription.textContent = description;
      fileEl.appendChild(fileDescription);

      fileEl.addEventListener("mouseenter", () => {
        const tooltip = fileEl.querySelector(".tooltip");
        if (tooltip) {
          tooltip.classList.add("show");
        }
      });

      fileEl.addEventListener("mousemove", function (event) {
        const tooltip = fileEl.querySelector(".tooltip");

        if (tooltip) {
          tooltip.style.left = event.clientX + window.scrollX + 10 + "px";
          tooltip.style.top = event.clientY + window.scrollY + 10 + "px";
        }
      });

      fileEl.addEventListener("mouseleave", () => {
        const tooltip = fileEl.querySelector(".tooltip");
        if (tooltip) {
          tooltip.classList.remove("show");
        }
      });
    }

    fileEl.addEventListener("click", () => {
      this.openFileInTab(normPath, file.name);
      this.setSelectedItem(normPath, "file");
    });

    parent.appendChild(fileEl);
  }

  // ========================= ФАЙЛЫ/ПАПКИ =========================

  async selectFolder(folderPath) {
    this.currentPath = folderPath;
  }

  async openFileInTab(filePath, fileName) {
    const normPath = this.normalizePath(filePath);

    if (this.openFiles.has(normPath)) {
      this.switchToTab(normPath);
      return;
    }

    try {
      const [contentData, descData] = await Promise.all([
        this.apiGet(`/api/file-content?path=${encodeURIComponent(normPath)}`),
        this.apiGet(`/api/description?path=${encodeURIComponent(normPath)}`),
      ]);

      this.openFiles.set(normPath, {
        name: fileName,
        content: contentData.content,
        description: descData.description || "",
        path: normPath,
      });

      this.createTab(normPath, fileName);
      this.switchToTab(normPath);
    } catch (e) {
      console.error("Ошибка открытия файла:", e);
    }
  }

  createTab(filePath, fileName) {
    const tabsContainer = UI.byId("file-tabs-list");
    const tab = document.createElement("button");
    tab.className = "file-tab";
    tab.dataset.file = filePath;

    const tabName = document.createElement("span");
    tabName.className = "tab-name";
    tabName.textContent = fileName;
    tab.appendChild(tabName);

    const closeTab = document.createElement("span");
    closeTab.className = "close-tab";
    closeTab.textContent = "\u00d7";
    tab.appendChild(closeTab);

    tab.addEventListener("click", () => {
      this.switchToTab(tab.dataset.file);
    });

    closeTab.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(tab.dataset.file);
    });

    const emptyTab = tabsContainer.querySelector(".empty-tab");
    if (emptyTab) emptyTab.remove();

    tabsContainer.appendChild(tab);
  }

  switchToTab(filePath) {
    if (!this.openFiles.has(filePath)) return;

    document
      .querySelectorAll(".file-tab")
      .forEach((t) => t.classList.remove("active"));
    const tab = document.querySelector(`[data-file="${filePath}"]`);
    tab.scrollIntoView({behavior: "smooth", block: "nearest"});
    if (tab) tab.classList.add("active");

    this.activeTab = filePath;
    this.currentFile = filePath;

    const fileData = this.openFiles.get(filePath);
    UI.byId("editor-title").textContent = fileData.name;
    UI.byId("file-description").value = fileData.description;

    const editorCodeContent = UI.byId("code-content");
    editorCodeContent.textContent = fileData.content;
    editorCodeContent.classList = "";
    editorCodeContent.classList.add("language-" + fileData.name.split(".")[1]);
    Prism.highlightElement(editorCodeContent);

    UI.showEditorButtons();
  }

  closeTab(filePath) {
    if (!this.openFiles.has(filePath)) return;
    this.openFiles.delete(filePath);

    const tab = document.querySelector(`[data-file="${filePath}"]`);
    if (tab) tab.remove();

    if (this.activeTab === filePath) {
      this.activeTab = null;
      this.currentFile = null;
      const remaining = document.querySelectorAll(".file-tab");
      if (remaining.length) {
        this.switchToTab(remaining[remaining.length - 1].dataset.file);
      } else {
        UI.showEmptyState();
      }
    }

    const tabsContainer = UI.byId("file-tabs-list");
    if (!tabsContainer.children.length) {
      tabsContainer.innerHTML =
        '<div class="empty-tab">Выберите файл для редактирования</div>';
    }
  }

  // переключатель папки: используется folderCache, expandedFolders
  async toggleFolder(folderPath, childrenContainer) {
    const header =
      childrenContainer?.parentElement?.querySelector(".folder-header");
    const currentlyExpanded = this.expandedFolders.has(folderPath);

    if (!currentlyExpanded) {
      // разворачиваем
      this.expandedFolders.add(folderPath);
      header.dataset.expanded = "true";

      if (this.folderCache.has(folderPath)) {
        // если в кэше — рендерим из него
        this.renderChildrenFromCache(
          folderPath,
          childrenContainer,
          parseInt(header.dataset.level || "0")
        );
      } else if (header.dataset.hasChildren === "true") {
        // иначе подгружаем
        await this.loadFolderChildren(
          folderPath,
          childrenContainer,
          parseInt(header.dataset.level || "0")
        );
      }
    } else {
      // сворачиваем
      this.expandedFolders.delete(folderPath);
      header.dataset.expanded = "false";
    }
  }

  // ========================= CRUD =========================

  async createFolder() {
    const name = UI.byId("folder-name-input").value.trim();
    if (!name) return;

    try {
      await this.apiSend("/api/folder", "POST", {path: this.currentPath, name});
      UI.hideModal("create-folder-modal");
      UI.byId("folder-name-input").value = "";

      // Обновляем только родительскую папку (перезапрашиваем и обновляем кэш)
      const parentPath = this.normalizePath(this.currentPath || "/");
      this.invalidateLoadedFolders(parentPath);

      const header = document.querySelector(
        `.folder-header[data-path="${parentPath}"]`
      );
      const container = header?.nextElementSibling;
      if (header && container) {
        // если родитель раскрыт — перезагрузим его содержимое
        if (this.expandedFolders.has(parentPath) || parentPath === "/") {
          await this.loadFolderChildren(
            parentPath,
            container,
            parseInt(header.dataset.level || "0")
          );
          this.restoreExpandedChildren(parentPath);
        }
      } else {
        // если узел не в DOM, обновим корень
        await this.refreshTreeAndDescriptions();
      }
    } catch (e) {
      console.error("Ошибка создания папки:", e);
    }
  }

  async uploadFiles(e) {
    const files = e.target.files;
    for (const file of files) {
      const formData = new FormData();
      formData.append("path", this.currentPath);
      formData.append("file", file);
      try {
        await fetch("/api/upload", {method: "POST", body: formData});
      } catch (err) {
        console.error("Ошибка загрузки файла:", err);
      }
    }
    e.target.value = "";

    // Обновим текущую папку
    const parentPath = this.normalizePath(this.currentPath || "/");
    const header = document.querySelector(
      `.folder-header[data-path="${parentPath}"]`
    );
    const container = header?.nextElementSibling;
    this.invalidateLoadedFolders(parentPath);
    if (header && container) {
      await this.loadFolderChildren(
        parentPath,
        container,
        parseInt(header.dataset.level || "0")
      );
      this.restoreExpandedChildren(parentPath);
    } else await this.refreshTreeAndDescriptions();
  }

  async deleteSelectedItem() {
    if (!this.selectedItem) return;
    const {path, type} = this.selectedItem;
    const normPath = this.normalizePath(path);
    if (!confirm(`Удалить ${type === "folder" ? "папку" : "файл"}?`)) return;

    try {
      await this.apiSend(
        `/api/item?path=${encodeURIComponent(normPath)}`,
        "DELETE"
      );

      // Закрываем табы, которые относятся к удалённому пути (файл) или вложенным (папка)
      for (const filePath of Array.from(this.openFiles.keys())) {
        if (
          filePath === normPath ||
          filePath.startsWith(normPath + "/") ||
          (normPath === "/" && filePath)
        ) {
          this.closeTab(filePath);
        }
      }

      // Обновляем родителя
      const parentPath = this.getParentPath(normPath) || "/";
      this.invalidateLoadedFolders(parentPath);
      const header = document.querySelector(
        `.folder-header[data-path="${parentPath}"]`
      );
      const container = header?.nextElementSibling;
      if (header && container) {
        await this.loadFolderChildren(
          parentPath,
          container,
          parseInt(header.dataset.level || "0")
        );
        this.restoreExpandedChildren(parentPath);
      } else {
        await this.refreshTreeAndDescriptions();
      }

      this.selectedItem = null;
      this.setSelectedItem(null, null);
    } catch (e) {
      console.error("Ошибка удаления:", e);
    }
  }

  async renameSelectedItem() {
    if (!this.selectedItem) return;
    const {path, type} = this.selectedItem;
    this.renameData = {path, type};
    UI.byId("rename-input").value = this.getNameFromPath(path);
    UI.showModal("rename-modal");
  }

  async confirmRename() {
    const newName = UI.byId("rename-input").value.trim();
    if (!newName) return;
    try {
      const res = await this.apiSend("/api/rename", "PUT", {
        oldPath: this.renameData.path,
        newName,
      });

      const oldPath = this.normalizePath(this.renameData.path);
      const newPath =
        res.newPath || this.getParentPath(oldPath) + "/" + newName;
      UI.hideModal("rename-modal");

      // Обновляем expandedFolders
      const updatedExpanded = new Set();
      for (const path of this.expandedFolders) {
        if (path === oldPath) {
          updatedExpanded.add(newPath);
        } else if (path.startsWith(oldPath + "/")) {
          updatedExpanded.add(path.replace(oldPath, newPath));
        } else {
          updatedExpanded.add(path);
        }
      }
      this.expandedFolders = updatedExpanded;

      // Обновляем folderCache
      const updatedCache = new Map();
      for (const [path, data] of this.folderCache.entries()) {
        if (path === oldPath) {
          updatedCache.set(newPath, data);
        } else if (path.startsWith(oldPath + "/")) {
          updatedCache.set(
            path.replace(oldPath, newPath),
            data.map((item) => ({
              ...item,
              path: item.path.replace(oldPath, newPath),
            }))
          );
        } else {
          updatedCache.set(path, data);
        }
      }
      this.folderCache = updatedCache;

      // Обновляем openFiles
      const newOpenFiles = new Map();
      for (const [path, fileData] of this.openFiles.entries()) {
        if (path === oldPath) {
          newOpenFiles.set(newPath, {
            ...fileData,
            path: newPath,
            name: newName,
          });
        } else if (path.startsWith(oldPath + "/")) {
          const newFilePath = path.replace(oldPath, newPath);
          newOpenFiles.set(newFilePath, {
            ...fileData,
            path: newFilePath,
            name: fileData.name,
          });
        } else {
          newOpenFiles.set(path, fileData);
        }
      }
      this.openFiles = newOpenFiles;

      // Обновляем табы
      const tabs = document.querySelectorAll(".file-tab");
      tabs.forEach((tab) => {
        const filePath = tab.dataset.file;
        if (filePath === oldPath) {
          tab.dataset.file = newPath;
          const tabName = tab.querySelector(".tab-name");
          if (tabName) tabName.textContent = newName;
        } else if (filePath.startsWith(oldPath + "/")) {
          const newFilePath = filePath.replace(oldPath, newPath);
          tab.dataset.file = newFilePath;
        }
      });

      // Обновляем активный таб
      if (this.activeTab) {
        if (this.activeTab === oldPath) {
          this.activeTab = newPath;
        } else if (this.activeTab.startsWith(oldPath + "/")) {
          this.activeTab = this.activeTab.replace(oldPath, newPath);
        }
      }

      // Обновляем selectedItem
      if (this.selectedItem) {
        if (this.selectedItem.path === oldPath) {
          this.selectedItem.path = newPath;
        } else if (this.selectedItem.path.startsWith(oldPath + "/")) {
          this.selectedItem.path = this.selectedItem.path.replace(
            oldPath,
            newPath
          );
        }
      }

      // Инвалидируем кэш и перезагружаем
      const parentPath = this.getParentPath(oldPath) || "/";
      this.invalidateLoadedFolders(parentPath);
      const header = document.querySelector(
        `.folder-header[data-path="${parentPath}"]`
      );
      const container = header?.nextElementSibling;
      if (header && container) {
        await this.loadFolderChildren(
          parentPath,
          container,
          parseInt(header.dataset.level || "0")
        );
        this.restoreExpandedChildren(parentPath);
      } else {
        await this.refreshTreeAndDescriptions();
      }

      // Переключаемся на обновленный таб
      if (this.activeTab) {
        this.switchToTab(this.activeTab);
      }
    } catch (e) {
      console.error("Ошибка переименования:", e);
    }
  }

  async saveDescription() {
    if (!this.currentFile) return;
    const description = UI.byId("file-description").value;
    try {
      await this.apiSend("/api/description", "POST", {
        path: this.currentFile,
        description,
      });
      this.descriptions[this.currentFile] = description;
      if (this.openFiles.has(this.currentFile)) {
        this.openFiles.get(this.currentFile).description = description;
      }

      // Обновим визуально описание в дереве (если элемент есть)
      const fileEl = document.querySelector(
        `[data-path="${this.currentFile}"]`
      );
      if (fileEl) {
        // простая стратегия — перерендер родителя
        const parentPath =
          this.currentFile.split("/").slice(0, -1).join("/") || "/";
        const header = document.querySelector(
          `.folder-header[data-path="${parentPath}"]`
        );
        const container = header?.nextElementSibling;
        if (header && container) {
          this.invalidateLoadedFolders(parentPath);
          await this.loadFolderChildren(
            parentPath,
            container,
            parseInt(header.dataset.level || "0")
          );
          this.restoreExpandedChildren(parentPath);
        }
      }

      alert("Описание сохранено");
    } catch (e) {
      console.error("Ошибка сохранения описания:", e);
    }
  }

  async downloadFile() {
    if (!this.currentFile) return;
    try {
      const res = await this.apiDownload(
        `/api/download?path=${encodeURIComponent(this.currentFile)}`
      );
      const a = document.createElement("a");
      a.href = res;
      a.download = this.currentFile.split("/").pop();
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error("Ошибка скачивания файла:", e);
    }
  }

  // ========================= UI =========================

  showCreateFolderModal() {
    UI.showModal("create-folder-modal");
  }

  setSelectedItem(path, type) {
    UI.clearActiveItems();
    const el = path ? document.querySelector(`[data-path="${path}"]`) : null;
    if (el) el.classList.add("active");
    this.selectedItem = path ? {path, type} : null;
    this.selectFolder(this.getParentPath(path));
    UI.toggleActionButtons(!!path, type, path);
  }
}

// ========================= UI HELPERS =========================

const UI = {
  byId: (id) => document.getElementById(id),

  showModal: (id) => UI.byId(id).classList.add("active"),
  hideModal: (id) => UI.byId(id).classList.remove("active"),

  clearActiveItems: () => {
    document
      .querySelectorAll(".tree-item")
      .forEach((el) => el.classList.remove("active"));
  },

  toggleActionButtons: (visible, type, path) => {
    const renameBtn = UI.byId("rename-item-btn");
    const deleteBtn = UI.byId("delete-item-btn");

    // Если выбран корень — скрываем кнопки
    if (path === "/") {
      renameBtn.style.display = deleteBtn.style.display = "none";
      return;
    }

    if (visible) {
      renameBtn.style.display = deleteBtn.style.display = "inline-block";
      renameBtn.textContent = `Переименовать ${
        type === "folder" ? "папку" : "файл"
      }`;
      deleteBtn.textContent = `Удалить ${type === "folder" ? "папку" : "файл"}`;
    } else {
      renameBtn.style.display = deleteBtn.style.display = "none";
    }
  },

  showEmptyState: () => {
    UI.byId("editor-title").textContent = "Редактор";
    UI.byId("file-description").value = "";
    UI.byId("code-content").textContent =
      "Выберите файл для просмотра содержимого";
    UI.byId("save-description-btn").style.display = "none";
    UI.byId("download-file-btn").style.display = "none";
  },

  showEditorButtons: () => {
    UI.byId("save-description-btn").style.display = "inline-block";
    UI.byId("download-file-btn").style.display = "inline-block";
  },
};

// ========================= Запуск =========================
const fileManager = new FileManager();
