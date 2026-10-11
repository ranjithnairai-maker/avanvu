import type { Metadata } from 'next';
import { DraftNotice, SupportContact } from '@/components/DraftNotice';
import { brand, site } from '@/lib/site';

export const metadata: Metadata = { title: 'Privacy Policy' };

const SUBPROCESSORS = [
  ['Supabase', 'Sign-in and database hosting (United States)'],
  ['Google Cloud', 'Application servers, queues and encryption keys (United States)'],
  ['Anthropic', 'Language processing of your profile and interview text'],
  ['ElevenLabs', 'Turning session scripts into speech'],
  ['RevenueCat', 'Subscription status'],
  ['Expo', 'App delivery and push notifications'],
  ['PostHog', 'Product analytics, only if you allow it'],
  ['Sentry', 'Crash and error reports, with personal content removed'],
  ['Vercel', 'This website'],
  ['Email provider', 'Sign-in codes by email'],
];

const RETENTION = [
  ['Interview answers', '90 days after you confirm your summary, then permanently deleted'],
  [
    'Profile versions, sessions, scripts, audio, check-ins and debriefs',
    'Until you delete them or your account',
  ],
  ['Data exports', '72 hours'],
  ['Purchase webhook records', '90 days'],
  ['Usage and safety metadata (no personal text)', '13 months'],
  ['Application logs (redacted)', '30 days'],
];

export default function Privacy() {
  return (
    <article>
      <h1>Privacy Policy</h1>
      <p className="small">Version {site.documentVersion}</p>
      <DraftNotice />

      <p>
        This policy explains what {brand.productName} collects, why, who it is shared with, and the choices
        you have.
        {brand.productName} is for adults 18 and over.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          Account details: your Apple or email sign-in identifier, and a record that you confirmed you are 18
          or older (no birth date).
        </li>
        <li>
          What you tell us: your event, sport, the interview conversation, your profile, check-ins and
          debriefs. This can reveal fitness and wellbeing information, so we treat it as sensitive and encrypt
          it.
        </li>
        <li>Sessions we create for you: scripts, transcripts and audio.</li>
        <li>Purchases: subscription status from Apple through RevenueCat. We never see your card details.</li>
        <li>
          Usage and diagnostics: which features are used and error reports, without your personal text.
          Analytics is optional.
        </li>
      </ul>

      <h2>How we use it</h2>
      <p>
        We use your information to run the interview, write and voice your sessions, schedule reminders you
        turn on, manage your subscription, keep the service safe and fix problems. We do not sell your
        information, use it for advertising, or allow our providers to train their models on your content.
      </p>

      <h2>Where it is processed</h2>
      <p>
        Your information is stored and processed in the United States, including by our AI and voice
        providers. By agreeing in the app you consent to this. The text of your profile is sent to Anthropic
        to write sessions, and the text of each session is sent to ElevenLabs to produce speech. Those
        providers may keep copies for a limited time under their own terms, even after you delete your
        account.
      </p>

      <h2>Who we share it with</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">Purpose</th>
          </tr>
        </thead>
        <tbody>
          {SUBPROCESSORS.map(([name, purpose]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Safety</h2>
      <p>
        If something you write suggests you may be in crisis, {brand.productName} stops and shows support
        resources instead of continuing. This check runs on our servers before your text is sent to an AI
        provider. A record that it happened (with no text) is kept for safety review.
      </p>

      <h2>How long we keep it</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Data</th>
            <th scope="col">Kept for</th>
          </tr>
        </thead>
        <tbody>
          {RETENTION.map(([what, howLong]) => (
            <tr key={what}>
              <td>{what}</td>
              <td>{howLong}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Database backups are kept for the period of our hosting plan, and deletions are re-applied if a backup
        is ever restored.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>Edit your profile, or delete any session, in the app.</li>
        <li>Download a copy of your data from You, then Export my data.</li>
        <li>
          Delete your account from You, then Delete my account.{' '}
          <a href="/delete-account">What deletion removes</a>.
        </li>
        <li>Turn notifications or analytics on or off at any time.</li>
        <li>
          Ask questions or make a privacy request: <SupportContact />.
        </li>
      </ul>
      <p>
        We design for Canadian privacy law (PIPEDA and applicable provincial law) and for the privacy laws of
        the US states where {brand.productName} is offered.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes in a way that matters, we will tell you in the app and ask you to agree again.
      </p>
    </article>
  );
}
