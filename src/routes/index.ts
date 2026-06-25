import { Router } from 'express';
import { authMiddleware, chatAuthMiddleware, requireRole } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rateLimit.middleware';
import { clientsController } from '../controllers/clients.controller';
import { appointmentsController } from '../controllers/appointments.controller';
import {
  servicesController,
  schedulesController,
  configController,
  aiController,
} from '../controllers/index';

const router = Router();

// ── Health check ─────────────────────────────────────────────
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'zac-barber-backend', ts: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════════
// RUTAS PROTEGIDAS — requieren JWT de Supabase Auth
// ══════════════════════════════════════════════════════════════
const auth = Router();
auth.use(authMiddleware);

// ── Clientes ──────────────────────────────────────────────────
auth.get('/clients', clientsController.list);
auth.get('/clients/:id', clientsController.getById);
auth.post('/clients', clientsController.create);
auth.patch('/clients/:id', clientsController.update);

// ── Servicios ─────────────────────────────────────────────────
auth.get('/services', servicesController.list);
auth.post('/services', requireRole('owner', 'admin'), servicesController.create);
auth.patch('/services/:id', requireRole('owner', 'admin'), servicesController.update);

// ── Citas ─────────────────────────────────────────────────────
auth.get('/availability', appointmentsController.availability);
auth.get('/appointments', appointmentsController.list);
auth.get('/appointments/:id', appointmentsController.getById);
auth.post('/appointments', appointmentsController.create);
auth.patch('/appointments/:id/cancel', appointmentsController.cancel);
auth.patch('/appointments/:id/reschedule', appointmentsController.reschedule);
auth.patch('/appointments/:id/complete', requireRole('owner', 'admin', 'barber'), appointmentsController.markCompleted);
auth.patch('/appointments/:id/no-show', requireRole('owner', 'admin', 'barber'), appointmentsController.markNoShow);

// ── Horarios ──────────────────────────────────────────────────
auth.get('/schedules', schedulesController.list);
auth.patch('/schedules', schedulesController.update);

// ── Configuración ─────────────────────────────────────────────
auth.get('/business-config', configController.list);
auth.patch('/business-config', requireRole('owner', 'admin'), configController.update);

// ── AI (desde dashboard — usuario autenticado) ────────────────
auth.post('/ai/chat', aiLimiter, aiController.chat);

// ══════════════════════════════════════════════════════════════
// RUTAS PÚBLICAS DEL CHAT — solo requieren x-shop-id header
// Usadas por el widget embebido y WhatsApp
// Deben registrarse ANTES del router auth para que no sean
// interceptadas por authMiddleware
// ══════════════════════════════════════════════════════════════
const chat = Router();
chat.use(chatAuthMiddleware);
chat.post('/chat', aiLimiter, aiController.chat);

const dashboardPublic = Router();
dashboardPublic.use(chatAuthMiddleware);
dashboardPublic.get('/appointments', appointmentsController.dashboardList);
dashboardPublic.patch('/appointments/:id/status', appointmentsController.dashboardUpdateStatus);
dashboardPublic.delete('/appointments/:id', appointmentsController.dashboardDelete);

// Availability management
dashboardPublic.get('/schedules', appointmentsController.dashboardGetSchedules);
dashboardPublic.put('/schedules', appointmentsController.dashboardSaveSchedules);
dashboardPublic.get('/time-off', appointmentsController.dashboardGetTimeOff);
dashboardPublic.post('/time-off', appointmentsController.dashboardAddTimeOff);
dashboardPublic.delete('/time-off/:id', appointmentsController.dashboardDeleteTimeOff);
dashboardPublic.get('/closures', appointmentsController.dashboardGetClosures);
dashboardPublic.post('/closures', appointmentsController.dashboardAddClosure);
dashboardPublic.delete('/closures/:id', appointmentsController.dashboardDeleteClosure);

router.use('/public', chat);
router.use('/public/dashboard', dashboardPublic);

router.use(auth);

export default router;
