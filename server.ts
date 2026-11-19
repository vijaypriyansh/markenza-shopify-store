import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import dotenv from 'dotenv';
import JSZip from 'jszip';

dotenv.config();

interface FirebaseConfig {
  projectId: string;
  apiKey: string;
  firestoreDatabaseId: string;
}

const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig: FirebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const uploadsDir = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const ALLOWED_MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

const BOOTSTRAPPED_ADMIN_EMAIL = 'vijaypriyanshpersonal@gmail.com';

async function verifyAdminToken(idToken: string): Promise<{ uid: string; email: string } | null> {
  try {
    const lookupRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!lookupRes.ok) return null;
    const lookupData = (await lookupRes.json()) as {
      users?: Array<{ localId?: string; email?: string; emailVerified?: boolean }>;
    };
    const user = lookupData.users?.[0];
    if (!user || !user.localId || !user.email || !user.emailVerified) {
      return null;
    }

    if (user.email.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase()) {
      return { uid: user.localId, email: user.email };
    }

    const dbId = firebaseConfig.firestoreDatabaseId || '(default)';
    const adminDocUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      firebaseConfig.projectId
    )}/databases/${encodeURIComponent(dbId)}/documents/admins/${encodeURIComponent(user.localId)}`;

    const adminRes = await fetch(adminDocUrl, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (adminRes.ok) {
      return { uid: user.localId, email: user.email };
    }
    return null;
  } catch {
    return null;
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '15mb' }));

  app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));

  app.post('/api/upload', async (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const adminUser = await verifyAdminToken(token);
    if (!adminUser) {
      res.status(403).json({ error: 'Admin authorization required' });
      return;
    }

    const body = req.body as { mimeType?: string; dataBase64?: string };
    const mimeType = typeof body?.mimeType === 'string' ? body.mimeType.toLowerCase() : '';
    const ext = ALLOWED_MIME_EXT[mimeType];
    if (!ext) {
      res.status(400).json({ error: 'Unsupported file format. Upload PNG, JPG, WebP, SVG, MP4, or WebM.' });
      return;
    }

    const rawBase64 = typeof body?.dataBase64 === 'string' ? body.dataBase64 : '';
    const cleanBase64 = rawBase64.includes(',') ? rawBase64.split(',')[1] || '' : rawBase64;
    if (!cleanBase64) {
      res.status(400).json({ error: 'Missing file payload' });
      return;
    }

    const buffer = Buffer.from(cleanBase64, 'base64');
    if (buffer.byteLength === 0 || buffer.byteLength > 10 * 1024 * 1024) {
      res.status(400).json({ error: 'File must be under 10 MB' });
      return;
    }

    const filename = `${crypto.randomUUID()}${ext}`;
    const targetPath = path.join(uploadsDir, filename);
    fs.writeFileSync(targetPath, buffer);

    res.json({ url: `/uploads/${filename}` });
  });

  const wpThemeRoot = path.resolve(process.cwd(), 'wordpress-theme', 'markenza');

  const collectThemeFiles = (dir: string, prefix = ''): Array<{ relPath: string; fullPath: string }> => {
    if (!fs.existsSync(dir)) return [];
    const results: Array<{ relPath: string; fullPath: string }> = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...collectThemeFiles(fullPath, relPath));
      } else {
        results.push({ relPath, fullPath });
      }
    }
    return results;
  };

  app.get('/api/wordpress-theme-manifest', (_req, res) => {
    const files = collectThemeFiles(wpThemeRoot);
    const items = files.map((f) => {
      const ext = path.extname(f.relPath).toLowerCase();
      const isText = ['.php', '.css', '.js', '.json', '.txt', '.md'].includes(ext);
      return {
        path: f.relPath,
        size: fs.statSync(f.fullPath).size,
        content: isText ? fs.readFileSync(f.fullPath, 'utf-8') : null,
      };
    });
    res.json({ themeName: 'markenza', files: items });
  });

  app.get('/api/download-wordpress-theme', async (_req, res) => {
    try {
      const files = collectThemeFiles(wpThemeRoot);
      if (files.length === 0) {
        res.status(404).json({ error: 'WordPress theme files not found.' });
        return;
      }
      const zip = new JSZip();
      const rootFolder = zip.folder('markenza');
      if (!rootFolder) {
        res.status(500).json({ error: 'Failed to initialize archive.' });
        return;
      }
      for (const file of files) {
        rootFolder.file(file.relPath, fs.readFileSync(file.fullPath));
      }
      const zipBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="markenza-wordpress-theme.zip"');
      res.send(zipBuffer);
    } catch {
      res.status(500).json({ error: 'Failed to generate WordPress theme zip.' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== 'true' },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Markenza server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
