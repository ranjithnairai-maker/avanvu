import { Manrope_600SemiBold, Manrope_700Bold, useFonts } from '@expo-google-fonts/manrope';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ToastProvider } from '@/components/Toast';
import { startAuthListener } from '@/lib/auth/store';
import '@/lib/native/background';
import { ThemeProvider, useTheme } from '@/theme/theme';

SplashScreen.preventAutoHideAsync();
startAuthListener();

function Shell() {
  const { colors, scheme } = useTheme();
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.textPrimary,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="dev/index" options={{ headerShown: true, title: 'Developer tools' }} />
        <Stack.Screen name="dev/gallery" options={{ headerShown: true, title: 'Component gallery' }} />
        <Stack.Screen name="dev/spikes/audio" options={{ headerShown: true, title: 'Spike: playback' }} />
        <Stack.Screen
          name="dev/spikes/age-range"
          options={{ headerShown: true, title: 'Spike: age range' }}
        />
        <Stack.Screen
          name="dev/spikes/dictation"
          options={{ headerShown: true, title: 'Spike: dictation' }}
        />
        <Stack.Screen name="safety" options={{ gestureEnabled: false, animation: 'fade' }} />
        <Stack.Screen name="paywall" options={{ presentation: 'modal' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ Manrope_600SemiBold, Manrope_700Bold });
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }),
  );

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync();
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={client}>
          <ThemeProvider>
            <BottomSheetModalProvider>
              <ToastProvider>
                <Shell />
              </ToastProvider>
            </BottomSheetModalProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
