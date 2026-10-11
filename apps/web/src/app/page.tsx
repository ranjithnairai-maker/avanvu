import { brand } from '@/lib/site';

const STEPS = [
  {
    title: 'A real interview',
    body: 'Tell Avanvu about your event, your sport and what you want to feel on the day. It asks follow-up questions, then shows you a profile you can read and edit.',
  },
  {
    title: 'Sessions built around your event',
    body: 'Training rehearsals build toward a night-before session and a short pre-event primer, timed to your date.',
  },
  {
    title: 'Voiced, with music, ready offline',
    body: 'Choose a voice and a music style. Download a session once and play it with no connection, on the lock screen or in the background.',
  },
];

/** Landing page. Claims follow SPEC §1.2: "mental rehearsal" and "helps you prepare", never performance promises. */
export default function Home() {
  return (
    <>
      <section className="hero">
        <div className="orb" aria-hidden="true" />
        <h1>{brand.tagline}</h1>
        <p className="lede">{brand.supportingLine}</p>
        <p>
          {brand.productName} interviews you about an upcoming event and creates personalized mental rehearsal
          sessions that help you prepare. For adults 18 and over.
        </p>
        <p className="small">Coming soon to the App Store for iPhone.</p>
      </section>

      <section aria-labelledby="how">
        <h2 id="how">How it works</h2>
        {STEPS.map((s) => (
          <div key={s.title} className="card">
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </div>
        ))}
      </section>

      <section aria-labelledby="not">
        <h2 id="not">What {brand.productName} is not</h2>
        <p>
          {brand.productName} is performance preparation. It is not therapy, medical care, rehabilitation or
          emergency support, and it is not a substitute for a coach or clinician. The complete{' '}
          {brand.productName} protocol has not been clinically validated. If you are in crisis, contact your
          local emergency number or crisis line.
        </p>
      </section>
    </>
  );
}
