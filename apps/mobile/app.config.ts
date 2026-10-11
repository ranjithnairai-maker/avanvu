import type { ExpoConfig } from 'expo/config';

/**
 * The bundle identifier is chosen once the legal entity and App Store record exist (D-25) and never
 * changes after release. Until then development builds use AVANVU_BUNDLE_ID from the environment.
 * Brand strings mirror packages/core/src/brand.ts (kept literal here because app config cannot import
 * workspace TypeScript reliably); brand.test.ts asserts they stay in sync.
 */
const env = (process.env.EXPO_PUBLIC_ENV ?? 'local') as 'local' | 'preview' | 'production';

const config: ExpoConfig = {
  name: 'Avanvu',
  slug: 'avanvu',
  scheme: 'avanvu',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: './assets/images/icon.png',
  ios: {
    supportsTablet: false,
    bundleIdentifier: process.env.AVANVU_BUNDLE_ID ?? 'com.example.avanvu.dev',
    deploymentTarget: '26.0',
    entitlements: { 'com.apple.developer.declared-age-range': true },
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      { backgroundColor: '#0B0F1A', image: './assets/images/splash-icon.png', imageWidth: 76 },
    ],
    // Background playback is justified by real session playback (SPEC §12.6).
    ['expo-audio', { enableBackgroundPlayback: true, microphonePermission: false }],
    [
      'expo-speech-recognition',
      {
        microphonePermission:
          'Avanvu uses the microphone so you can dictate your answers. Audio stays on your device.',
        speechRecognitionPermission: 'Avanvu uses on-device speech recognition to turn your voice into text.',
      },
    ],
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
  extra: { env },
};

export default config;
