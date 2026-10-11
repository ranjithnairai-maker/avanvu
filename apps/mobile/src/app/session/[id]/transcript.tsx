import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { View } from 'react-native';
import { Notice } from '@/components/Notice';
import { Scaffold } from '@/components/Scaffold';
import { Skeleton } from '@/components/Skeleton';
import { Text } from '@/components/Text';
import { api } from '@/lib/api';

interface Transcript {
  title: string;
  items: (
    | { type: 'speech'; block: string; text: string }
    | { type: 'pause' | 'rehearse'; block: string; seconds: number }
  )[];
}

/** Read along (SPEC §8.2): the speech in order, with pauses shown subtly. Derived from the stored script (D-11). */
export default function TranscriptScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useQuery({
    queryKey: ['transcript', id],
    queryFn: () => api.get<Transcript>(`/v1/sessions/${id}/transcript`),
  });
  return (
    <Scaffold title={q.data?.title ?? 'Transcript'}>
      {q.isPending ? [0, 1, 2, 3].map((i) => <Skeleton key={i} height={48} />) : null}
      {q.isError ? (
        <Notice kind="error">The transcript isn't available offline. Connect to read it.</Notice>
      ) : null}
      {q.data?.items.map((it, i) =>
        it.type === 'speech' ? (
          <Text key={i} variant="body" style={{ marginTop: 4 }}>
            {it.text}
          </Text>
        ) : (
          <View
            key={i}
            accessible
            accessibilityLabel={`Pause, ${it.seconds} seconds`}
            style={{ paddingVertical: 4 }}
          >
            <Text variant="caption" tone="tertiary">
              {it.type === 'rehearse' ? `Your turn, ${it.seconds} seconds` : `Pause, ${it.seconds} seconds`}
            </Text>
          </View>
        ),
      )}
    </Scaffold>
  );
}
