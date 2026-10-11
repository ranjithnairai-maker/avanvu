import type { Metadata } from 'next';
import { SupportContact } from '@/components/DraftNotice';
import { brand } from '@/lib/site';

export const metadata: Metadata = { title: 'Delete your account' };

/** Public deletion information, required for the App Store listing (SPEC §12.6, §10.5). */
export default function DeleteAccountInfo() {
  return (
    <article>
      <h1>Delete your account</h1>
      <p className="lede">
        You can delete your {brand.productName} account and data at any time from inside the app.
      </p>

      <h2>How to delete</h2>
      <ol>
        <li>Open {brand.productName} and go to the You tab.</li>
        <li>Under Privacy and safety, choose Delete my account.</li>
        <li>Read the summary and confirm.</li>
      </ol>
      <p>
        Deleting starts right away, and you are signed out. If you cannot open the app, contact{' '}
        <SupportContact /> from the email address you used to sign in.
      </p>

      <h2>What is removed</h2>
      <ul>
        <li>
          Your profile, events, programs, interview answers, scripts, transcripts, audio, check-ins and
          debriefs.
        </li>
        <li>Your encryption keys, so any copy left in a backup cannot be read.</li>
        <li>
          Your sign-in, your subscription customer record, your analytics identity and your Sign in with Apple
          link.
        </li>
        <li>Downloaded sessions on your phone.</li>
      </ul>

      <h2>What may remain</h2>
      <ul>
        <li>
          A record that your account was deleted, kept so a deletion is re-applied if a backup is ever
          restored.
        </li>
        <li>Metadata with no personal text, such as usage counts, for up to 13 months.</li>
        <li>Copies held briefly by our AI and voice providers under their own retention terms.</li>
        <li>Purchase records held by Apple.</li>
      </ul>

      <h2>Your subscription</h2>
      <p>
        <strong>Deleting your account does not cancel your App Store subscription.</strong> Cancel it
        separately on your iPhone: Settings, your name, Subscriptions, {brand.productName}.
      </p>

      <h2>Get a copy first</h2>
      <p>In the app, open You and choose Export my data. The download link works for a short time.</p>
    </article>
  );
}
