import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import multer from "multer";
import favicon from "serve-favicon";

const app = express();
const PORT = 3000;
const FILES_DIR = "./files";
const UPLOAD_DIR = path.join(FILES_DIR, "uploads");
const DESCRIPTIONS_FILE = path.join(FILES_DIR, "descriptions.json");

app.use(favicon("./public/favicon.ico"));
app.use(cors());
app.use(express.json());
app.use(express.static("./public"));

// Создаем директории для загрузок
await fs.mkdir(FILES_DIR, {recursive: true});
await fs.mkdir(UPLOAD_DIR, {recursive: true});

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = req.body.path
      ? path.join(UPLOAD_DIR, req.body.path)
      : UPLOAD_DIR;
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});
const upload = multer({storage});

app.get("/api/tree", async (req, res) => {
  await fs.access(FILES_DIR).catch(async () => {
    await fs.mkdir(FILES_DIR, {recursive: true});
  });
  await fs.access(UPLOAD_DIR).catch(async () => {
    await fs.mkdir(UPLOAD_DIR, {recursive: true});
  });

  const relPath = req.query.path ? req.query.path : "";
  const targetPath = path.join(UPLOAD_DIR, relPath);
  try {
    const tree = await buildTree(targetPath);
    res.json(tree);
  } catch (err) {
    res.status(500).json({error: "Не удалось построить дерево"});
  }
});

async function buildTree(targetPath) {
  const stats = await fs.stat(targetPath);
  const name = path.basename(targetPath);
  const node = {
    name,
    path: targetPath.replace(UPLOAD_DIR, ""),
    type: stats.isDirectory() ? "folder" : "file",
  };

  if (stats.isDirectory()) {
    const items = await fs.readdir(targetPath);
    node.hasChildren = items.length > 0;
    node.children = await Promise.all(
      items.map(async (item) => {
        const itemPath = path.join(targetPath, item);
        const s = await fs.stat(itemPath);
        return {
          name: item,
          path: itemPath.replace(UPLOAD_DIR, ""),
          type: s.isDirectory() ? "folder" : "file",
          hasChildren: s.isDirectory()
            ? (await fs.readdir(itemPath)).length > 0
            : undefined,
        };
      })
    );
  }
  return node;
}

// Создание папки
app.post("/api/folder", async (req, res) => {
  try {
    const {path: folderPath, name} = req.body;
    const fullPath = path.join(UPLOAD_DIR, folderPath || "", name);
    await fs.mkdir(fullPath, {recursive: true});
    res.json({success: true, path: path.relative(UPLOAD_DIR, fullPath)});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Удаление папки или файла
app.delete("/api/item", async (req, res) => {
  try {
    const {path: itemPath} = req.query;
    const fullPath = path.join(UPLOAD_DIR, itemPath);

    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) {
      await fs.rmdir(fullPath, {recursive: true});
    } else {
      await fs.unlink(fullPath);
    }

    res.json({success: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Переименование папки или файла
app.put("/api/rename", async (req, res) => {
  try {
    const {oldPath, newName} = req.body;
    const oldFullPath = path.join(UPLOAD_DIR, oldPath);
    const newFullPath = path.join(path.dirname(oldFullPath), newName);

    await fs.rename(oldFullPath, newFullPath);

    // Update description when renaming
    const descriptionsPath = DESCRIPTIONS_FILE;
    let descriptions = {};
    try {
      const data = await fs.readFile(descriptionsPath, "utf-8");
      descriptions = JSON.parse(data);
    } catch (error) {
      // File may not exist
    }
    const pathNodes = oldPath.split("/");
    pathNodes[pathNodes.length - 1] = newName;
    const newPath = pathNodes.join("/");

    if (descriptions[oldPath]) {
      descriptions[newPath] = descriptions[oldPath];
      delete descriptions[oldPath];
      await fs.writeFile(
        descriptionsPath,
        JSON.stringify(descriptions, null, 2)
      );
    }

    res.json({success: true, newPath});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Загрузка файла
app.post("/api/upload", upload.single("file"), (req, res) => {
  res.json({success: true, file: req.file});
});

// Скачивание файла
app.get("/api/download", async (req, res) => {
  try {
    const {path: filePath} = req.query;
    const fullPath = path.join(UPLOAD_DIR, filePath);
    res.download(fullPath);
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Чтение содержимого файла
app.get("/api/file-content", async (req, res) => {
  try {
    const {path: filePath} = req.query;
    const fullPath = path.join(UPLOAD_DIR, filePath);
    const content = await fs.readFile(fullPath, "utf-8");
    res.json({content});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Сохранение описания файла
app.post("/api/description", async (req, res) => {
  try {
    const {path: filePath, description} = req.body;
    const descriptionsPath = DESCRIPTIONS_FILE;

    let descriptions = {};
    try {
      const data = await fs.readFile(descriptionsPath, "utf-8");
      descriptions = JSON.parse(data);
    } catch (error) {
      // Файл может не существовать
    }

    if (!description || description === "") {
      delete descriptions[filePath];
    } else {
      descriptions[filePath] = description;
    }
    await fs.writeFile(descriptionsPath, JSON.stringify(descriptions, null, 2));
    res.json({success: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Получение описания файла
app.get("/api/description", async (req, res) => {
  try {
    const {path: filePath} = req.query;
    const descriptionsPath = DESCRIPTIONS_FILE;

    let descriptions = {};
    try {
      const data = await fs.readFile(descriptionsPath, "utf-8");
      descriptions = JSON.parse(data);
    } catch (error) {
      // Файл может не существовать
    }
    console.log("🚀 ~ descriptions:", descriptions);
    console.log("🚀 ~ filePath:", filePath);
    console.log(
      "🚀 ~ descriptions:",
      filePath
        ? {description: descriptions[filePath] || ""}
        : {description: descriptions}
    );

    res.json(
      filePath
        ? {description: descriptions[filePath] || ""}
        : {description: descriptions}
    );
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});
