import type { Metadata } from 'next';
import { DraftNotice, SupportContact } from '@/components/DraftNotice';
import { brand, site } from '@/lib/site';

export const metadata: Metadata = { title: 'Terms of Use' };

export default function Terms() {
  return (
    <article>
      <h1>Terms of Use</h1>
      <p className="small">Version {site.documentVersion}</p>
      <DraftNotice />

      <p>
        These terms govern your use of {brand.productName}. By creating an account you agree to them. If you
        do not agree, please do not use the app.
      </p>

      <h2>Who can use {brand.productName}</h2>
      <p>
        You must be 18 or older. We may ask you to confirm this, and we may close accounts that do not meet
        this requirement.
      </p>

      <h2>What {brand.productName} is, and is not</h2>
      <p>
        {brand.productName} creates mental rehearsal sessions to help you prepare for an event. It is not
        therapy, medical care, rehabilitation, diagnosis or emergency support, and it is not a substitute for
        a coach or clinician. The complete {brand.productName} protocol has not been clinically validated. We
        do not promise any result in your performance.
      </p>
      <p>
        Use sessions only in a safe, stationary setting. Never use {brand.productName} while driving,
        operating equipment, in water, or doing anything that needs your attention. Follow the guidance of
        your doctor, coach, event organizers and venue. Do not push through sharp, sudden or injury pain.
      </p>

      <h2>If you need help now</h2>
      <p>
        If you are in crisis or may harm yourself or others, contact your local emergency number or a crisis
        line right away. {brand.productName} is not able to respond in an emergency.
      </p>

      <h2>Your content</h2>
      <p>
        You keep ownership of what you tell us. You give us permission to process it to provide the service,
        as described in the <a href="/privacy">Privacy Policy</a>. Sessions are created for your personal use.
      </p>

      <h2>Subscriptions</h2>
      <p>
        Pro is an auto-renewing subscription billed by Apple. The price, period, any free trial and renewal
        terms are shown before you subscribe. Payment is charged to your Apple ID. The subscription renews
        unless you cancel at least 24 hours before the period ends; manage or cancel it in your Apple ID
        settings. Deleting your account does not cancel your subscription. Refunds are handled by Apple.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Do not misuse the service, attempt to break or overload it, reverse engineer it, or use it to create
        content that is unlawful or harms others.
      </p>

      <h2>Availability and changes</h2>
      <p>
        We work to keep {brand.productName} available but cannot promise it will always be uninterrupted. We
        may change features and these terms; if a change matters, we will tell you in the app.
      </p>

      <h2>Limits of liability</h2>
      <p>
        To the extent the law allows, {brand.productName} is provided as is, and we are not liable for
        indirect or consequential losses. Nothing in these terms limits rights you have under the law that
        cannot be limited.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms: <SupportContact />.
      </p>
    </article>
  );
}
