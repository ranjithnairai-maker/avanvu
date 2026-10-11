import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useEffect, useState } from 'react';
import { dictationAvailable } from '@avanvu/core';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';

const LOCALE = 'en-US';

/**
 * Spike (d): is on-device dictation available for this device and locale (SPEC §4.4)? Recognised text is
 * shown on screen only for the tester; it is never logged or sent anywhere.
 */
export default function DictationSpike() {
  const [facts, setFacts] = useState<string[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  const [text, setText] = useState('');

  useEffect(() => {
    (async () => {
      const recognitionAvailable = ExpoSpeechRecognitionModule.isRecognitionAvailable();
      const supportsOnDevice = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
      let localeInstalled: boolean;
      try {
        const { installedLocales } = await ExpoSpeechRecognitionModule.getSupportedLocales({});
        localeInstalled = installedLocales.some(
          (l) => l.replace('_', '-').toLowerCase() === LOCALE.toLowerCase(),
        );
      } catch {
        localeInstalled = false;
      }
      setFacts([
        `Recognition available: ${recognitionAvailable}`,
        `On-device supported: ${supportsOnDevice}`,
        `Locale ${LOCALE} installed on device: ${localeInstalled}`,
      ]);
      setAvailable(
        dictationAvailable({
          recognitionAvailable,
          supportsOnDevice,
          localeInstalledOnDevice: localeInstalled,
        }),
      );
    })();
  }, []);

  useSpeechRecognitionEvent('start', () => setListening(true));
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('result', (e) => {
    const best = e.results[0]?.transcript;
    if (best) setText(best);
  });
  useSpeechRecognitionEvent('error', (e) => setFacts((p) => [...p, `Error: ${e.error}`]));

  const start = async () => {
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      setFacts((p) => [...p, 'Permission not granted']);
      return;
    }
    ExpoSpeechRecognitionModule.start({
      lang: LOCALE,
      interimResults: true,
      requiresOnDeviceRecognition: true,
    });
  };

  return (
    <Screen>
      <Card>
        <Text variant="headline">Dictation decision</Text>
        <Text variant="body" tone="secondary">
          {available === null
            ? 'Checking'
            : available
              ? 'Offer the microphone (on-device)'
              : 'Hide the microphone (text only)'}
        </Text>
      </Card>
      {facts.map((f, i) => (
        <Text key={i} variant="callout" tone="secondary">
          {f}
        </Text>
      ))}
      <Button
        label={listening ? 'Stop' : 'Start dictation (on-device only)'}
        disabled={available === false}
        onPress={() => (listening ? ExpoSpeechRecognitionModule.stop() : start())}
      />
      <TextField label="Recognised text (editable)" value={text} onChangeText={setText} multiline />
    </Screen>
  );
}
