/**
 * Server push delivery (SPEC §9.6): at most once per (user, kind, subject) through notification_deliveries.
 * Copy is fixed; payloads carry ids only. Tokens that Expo reports as invalid are deleted.
 */
import { withSystemTx, type Db } from '../db/tx';
import { PUSH_COPY, type PushClient, type PushKind } from '../ports/push';

export type PushOutcome = 'sent' | 'no_devices' | 'already_sent' | 'failed';

export async function deliverNotification(
  db: Db,
  push: PushClient,
  notificationId: string,
  now: Date,
): Promise<PushOutcome> {
  const delivery = await withSystemTx(db, 'worker', (trx) =>
    trx
      .selectFrom('app.notification_deliveries')
      .selectAll()
      .where('id', '=', notificationId)
      .executeTakeFirst(),
  );
  if (!delivery) return 'already_sent';
  if (delivery.status === 'sent' || delivery.status === 'suppressed') return 'already_sent';

  const devices = await withSystemTx(db, 'worker', (trx) =>
    trx
      .selectFrom('app.devices')
      .select(['id', 'push_token'])
      .where('user_id', '=', delivery.user_id)
      .execute(),
  );
  if (devices.length === 0) {
    await withSystemTx(db, 'worker', (trx) =>
      trx
        .updateTable('app.notification_deliveries')
        .set({ status: 'suppressed' })
        .where('id', '=', notificationId)
        .execute(),
    );
    return 'no_devices';
  }

  const kind = delivery.kind as PushKind;
  const copy = PUSH_COPY[kind];
  let delivered = 0;
  const invalid: string[] = [];
  for (const d of devices) {
    const r = await push.send({
      token: d.push_token,
      kind,
      title: copy.title,
      body: copy.body,
      data: { kind, subject_id: delivery.subject_id },
    });
    if (r.ok) delivered++;
    else if (r.invalidToken) invalid.push(d.id);
  }
  await withSystemTx(db, 'worker', async (trx) => {
    for (const id of invalid) await trx.deleteFrom('app.devices').where('id', '=', id).execute();
    if (delivered > 0) {
      await trx
        .updateTable('app.notification_deliveries')
        .set({ status: 'sent', sent_at: now })
        .where('id', '=', notificationId)
        .where('status', '=', 'pending')
        .execute();
    }
  });
  return delivered > 0 ? 'sent' : 'failed';
}
