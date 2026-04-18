import { Router } from 'express';
import multer from 'multer';
import type { Container } from './container.js';

export function buildRoutes(container: Container): Router {
  const router = Router();
  const { controllers, config } = container;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes }
  });

  router.get('/api/health', controllers.health.health);

  router.get('/api/whatsapp/session', controllers.session.getSession);
  router.post('/api/whatsapp/session/connect', controllers.session.connect);
  router.post('/api/whatsapp/session/disconnect', controllers.session.disconnect);
  router.get('/api/whatsapp/instances', controllers.session.getInstances);

  router.get('/api/whatsapp/contacts', controllers.contacts.list);
  router.get('/api/whatsapp/contacts/:jid/photo', controllers.contacts.photo);
  router.post('/api/whatsapp/chats/:jid/seen', controllers.contacts.markSeen);

  router.get('/api/whatsapp/labels', controllers.labels.list);

  router.get('/api/whatsapp/events', controllers.events.list);
  router.get('/api/whatsapp/chats/:jid/messages', controllers.history.messages);

  router.post('/api/whatsapp/messages', controllers.messages.sendText);
  router.post('/api/whatsapp/messages/media', upload.single('file'), controllers.messages.sendMedia);

  return router;
}
