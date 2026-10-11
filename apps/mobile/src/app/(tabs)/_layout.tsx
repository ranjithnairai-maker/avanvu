import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useTheme } from '@/theme/theme';

/** Three tabs: Home, Library, You (SPEC §8). Native tab bar, SF Symbols, no badges or red dots. */
export default function TabsLayout() {
  const { colors } = useTheme();
  const icon = (name: string) =>
    function TabIcon({ color }: { color: ColorValue }) {
      return <SymbolView name={name as never} size={24} tintColor={color} />;
    };
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textTertiary,
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border },
        tabBarLabelStyle: { fontSize: 12 },
      }}
    >
      <Tabs.Screen name="home" options={{ title: 'Home', tabBarIcon: icon('house.fill') }} />
      <Tabs.Screen name="library" options={{ title: 'Library', tabBarIcon: icon('books.vertical.fill') }} />
      <Tabs.Screen name="you" options={{ title: 'You', tabBarIcon: icon('person.fill') }} />
    </Tabs>
  );
}
