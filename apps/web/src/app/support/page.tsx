import type { Metadata } from 'next';
import { SupportContact } from '@/components/DraftNotice';
import { brand } from '@/lib/site';

export const metadata: Metadata = { title: 'Support' };

const FAQ = [
  {
    q: 'A session is taking a long time to prepare.',
    a: 'Sessions are voiced and mixed on our servers, which usually takes a few minutes. You can leave the app; we will notify you when it is ready if notifications are on. If it shows as failed, open it and try again. A failed session does not use your allowance.',
  },
  {
    q: 'How do I play a session without a connection?',
    a: 'Open the session once while online so it downloads. Downloaded sessions show "Ready offline" in your Library and play with no connection.',
  },
  {
    q: 'How do I restore my subscription on a new phone?',
    a: 'Sign in with the same account, open You, then Restore purchases.',
  },
  {
    q: 'How do I cancel my subscription?',
    a: 'Subscriptions are managed by Apple. Open You, then Manage subscription, or go to Settings, your name, then Subscriptions on your iPhone.',
  },
  {
    q: 'How do I change my event date or my answers?',
    a: 'Open You. Choose your event to edit its name, date or time, or choose My profile to change what Avanvu knows about you. Changes apply to your next new session.',
  },
  {
    q: 'How do I get a copy of my data or delete my account?',
    a: 'Both are in You, under Privacy and safety. See the deletion page for what is removed.',
  },
];

export default function Support() {
  return (
    <article>
      <h1>Support</h1>
      <p className="lede">Help with {brand.productName}.</p>

      <h2>Contact us</h2>
      <p>
        Email <SupportContact />. Please do not include details about your event or health in an email; we can
        help without them. We cannot read your sessions or profile.
      </p>

      <h2>Common questions</h2>
      {FAQ.map((f) => (
        <div key={f.q} className="card">
          <h3>{f.q}</h3>
          <p>{f.a}</p>
        </div>
      ))}

      <h2>If you need help right now</h2>
      <p>
        {brand.productName} is not an emergency service. If you are in crisis or may harm yourself or others,
        contact your local emergency number or crisis line immediately.
      </p>
    </article>
  );
}
