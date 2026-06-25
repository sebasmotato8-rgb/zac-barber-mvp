import { Request, Response, NextFunction } from 'express';
import { AppointmentsService } from '../services/appointments.service';
import { AppointmentsRepository } from '../repositories/appointments.repository';
import { ClientsRepository } from '../repositories/clients.repository';
import { ServicesRepository } from '../repositories/services.repository';
import { getAuthClient, supabaseService } from '../integrations/supabase/client';
import {
  createAppointmentSchema,
  cancelAppointmentSchema,
  rescheduleAppointmentSchema,
  listAppointmentsSchema,
  availabilitySchema,
} from '../validators/appointments.validators';
import { ok, created } from '../shared/response';

function makeService(req: Request): AppointmentsService {
  const db = getAuthClient(req.ctx.jwt);
  return new AppointmentsService(
    new AppointmentsRepository(db),
    new ClientsRepository(db),
    new ServicesRepository(db)
  );
}

export const appointmentsController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const params = listAppointmentsSchema.parse(req.query);
      const svc = makeService(req);
      // Hoy: retorna la vista enriquecida
      if (params.date === new Date().toISOString().split('T')[0]) {
        const data = await svc.getTodayView(req.ctx.shopId);
        ok(res, data);
        return;
      }
      const result = await svc.list(req.ctx.shopId, params);
      ok(res, result.data, result.meta);
    } catch (err) {
      next(err);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const svc = makeService(req);
      const appt = await svc.getById(req.params['id']!, req.ctx.shopId);
      ok(res, appt);
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const dto = createAppointmentSchema.parse(req.body);
      const svc = makeService(req);
      const appt = await svc.create(req.ctx.shopId, dto);
      created(res, appt);
    } catch (err) {
      next(err);
    }
  },

  async cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const dto = cancelAppointmentSchema.parse(req.body);
      const svc = makeService(req);
      const appt = await svc.cancel(req.params['id']!, req.ctx.shopId, dto);
      ok(res, appt);
    } catch (err) {
      next(err);
    }
  },

  async reschedule(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const dto = rescheduleAppointmentSchema.parse(req.body);
      const svc = makeService(req);
      const appt = await svc.reschedule(req.params['id']!, req.ctx.shopId, dto);
      ok(res, appt);
    } catch (err) {
      next(err);
    }
  },

  async availability(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const dto = availabilitySchema.parse(req.query);
      const svc = makeService(req);
      const slots = await svc.getAvailability(req.ctx.shopId, dto);
      ok(res, slots);
    } catch (err) {
      next(err);
    }
  },

  async markCompleted(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const svc = makeService(req);
      const appt = await svc.markCompleted(req.params['id']!, req.ctx.shopId);
      ok(res, appt);
    } catch (err) {
      next(err);
    }
  },

  async markNoShow(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const svc = makeService(req);
      const appt = await svc.markNoShow(req.params['id']!, req.ctx.shopId);
      ok(res, appt);
    } catch (err) {
      next(err);
    }
  },

  async dashboardList(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const shopId = req.ctx.shopId;
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
      const { data, error } = await supabaseService
        .from('appointments')
        .select(`
          id, scheduled_at, ends_at, status, notes, source,
          clients(full_name, phone),
          services(name, price, duration_minutes),
          users!appointments_barber_id_fkey(full_name)
        `)
        .eq('shop_id', shopId)
        .gte('scheduled_at', `${today}T00:00:00`)
        .order('scheduled_at', { ascending: true })
        .limit(100);

      if (error) {
        next(error);
        return;
      }
      ok(res, data ?? []);
    } catch (err) {
      next(err);
    }
  },

  async dashboardUpdateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const shopId = req.ctx.shopId;
      const id = req.params['id'];
      const { status, reason } = req.body as { status: string; reason?: string };
      const update: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
      if (reason) update['cancellation_reason'] = reason;
      const { data, error } = await supabaseService
        .from('appointments')
        .update(update)
        .eq('id', id)
        .eq('shop_id', shopId)
        .select()
        .single();
      if (error) { next(error); return; }
      ok(res, data);
    } catch (err) {
      next(err);
    }
  },

  async dashboardDelete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const shopId = req.ctx.shopId;
      const id = req.params['id'];
      const { error } = await supabaseService
        .from('appointments')
        .delete()
        .eq('id', id)
        .eq('shop_id', shopId);
      if (error) { next(error); return; }
      ok(res, { deleted: true });
    } catch (err) {
      next(err);
    }
  },

  async dashboardGetSchedules(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { data, error } = await supabaseService
        .from('barber_schedules')
        .select('id, barber_id, day_of_week, start_time, end_time, is_active, users!barber_schedules_barber_id_fkey(full_name)')
        .eq('shop_id', req.ctx.shopId)
        .order('barber_id').order('day_of_week');
      if (error) { next(error); return; }
      ok(res, data ?? []);
    } catch (err) { next(err); }
  },

  async dashboardSaveSchedules(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const schedules = req.body as Array<{ barber_id: string; day_of_week: number; start_time: string; end_time: string; is_active: boolean }>;
      for (const s of schedules) {
        if (s.end_time <= s.start_time) { res.status(400).json({ success: false, error: { message: `Hora fin debe ser mayor que hora inicio (día ${s.day_of_week})` } }); return; }
        await supabaseService.from('barber_schedules').upsert({
          shop_id: req.ctx.shopId, barber_id: s.barber_id, day_of_week: s.day_of_week,
          start_time: s.start_time, end_time: s.end_time, is_active: s.is_active, updated_at: new Date().toISOString(),
        }, { onConflict: 'barber_id,day_of_week' });
      }
      ok(res, { saved: schedules.length });
    } catch (err) { next(err); }
  },

  async dashboardGetTimeOff(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { data, error } = await supabaseService
        .from('barber_time_off')
        .select('id, barber_id, starts_at, ends_at, reason, users!barber_time_off_barber_id_fkey(full_name)')
        .eq('shop_id', req.ctx.shopId)
        .gte('ends_at', new Date().toISOString())
        .order('starts_at');
      if (error) { next(error); return; }
      ok(res, data ?? []);
    } catch (err) { next(err); }
  },

  async dashboardAddTimeOff(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { barber_id, starts_at, ends_at, reason } = req.body as { barber_id: string; starts_at: string; ends_at: string; reason?: string };
      const { data, error } = await supabaseService
        .from('barber_time_off')
        .insert({ shop_id: req.ctx.shopId, barber_id, starts_at, ends_at, reason: reason ?? null })
        .select().single();
      if (error) { next(error); return; }
      ok(res, data);
    } catch (err) { next(err); }
  },

  async dashboardDeleteTimeOff(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await supabaseService.from('barber_time_off').delete().eq('id', req.params['id']).eq('shop_id', req.ctx.shopId);
      ok(res, { deleted: true });
    } catch (err) { next(err); }
  },

  async dashboardGetClosures(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { data, error } = await supabaseService
        .from('shop_closures')
        .select('id, closure_date, reason')
        .eq('shop_id', req.ctx.shopId)
        .gte('closure_date', new Date().toISOString().split('T')[0])
        .order('closure_date');
      if (error) { next(error); return; }
      ok(res, data ?? []);
    } catch (err) { next(err); }
  },

  async dashboardAddClosure(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { closure_date, reason } = req.body as { closure_date: string; reason?: string };
      const { data, error } = await supabaseService
        .from('shop_closures')
        .insert({ shop_id: req.ctx.shopId, closure_date, reason: reason ?? null })
        .select().single();
      if (error) { next(error); return; }
      ok(res, data);
    } catch (err) { next(err); }
  },

  async dashboardDeleteClosure(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await supabaseService.from('shop_closures').delete().eq('id', req.params['id']).eq('shop_id', req.ctx.shopId);
      ok(res, { deleted: true });
    } catch (err) { next(err); }
  },
};
