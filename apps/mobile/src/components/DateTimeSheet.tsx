import DateTimePicker from '@react-native-community/datetimepicker';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { forwardRef, useCallback, useState } from 'react';
import { View } from 'react-native';
import { radius } from '@avanvu/core';
import { useTheme } from '@/theme/theme';
import { Button } from './Button';
import { Text } from './Text';

interface Props {
  title: string;
  mode: 'date' | 'time';
  value: Date;
  minimumDate?: Date;
  maximumDate?: Date;
  onDone: (d: Date) => void;
}

/** Native iOS picker in a bottom sheet with a Done button (SPEC §7.5). */
export const DateTimeSheet = forwardRef<BottomSheetModal, Props>(function DateTimeSheet(
  { title, mode, value, minimumDate, maximumDate, onDone },
  ref,
) {
  const { colors, scheme } = useTheme();
  const [draft, setDraft] = useState(value);
  const backdrop = useCallback(
    (p: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.5} />
    ),
    [],
  );
  return (
    <BottomSheetModal
      ref={ref}
      enableDynamicSizing
      backdropComponent={backdrop}
      onChange={(i) => i >= 0 && setDraft(value)}
      backgroundStyle={{
        backgroundColor: colors.surface,
        borderTopLeftRadius: radius.card,
        borderTopRightRadius: radius.card,
      }}
      handleIndicatorStyle={{ backgroundColor: colors.borderStrong }}
    >
      <BottomSheetView style={{ padding: 20, gap: 12 }}>
        <Text variant="title2" accessibilityRole="header">
          {title}
        </Text>
        <View style={{ alignItems: 'center' }}>
          <DateTimePicker
            value={draft}
            mode={mode}
            display={mode === 'date' ? 'inline' : 'spinner'}
            themeVariant={scheme}
            {...(minimumDate ? { minimumDate } : {})}
            {...(maximumDate ? { maximumDate } : {})}
            onChange={(_e, d) => d && setDraft(d)}
          />
        </View>
        <Button
          label="Done"
          onPress={() => {
            onDone(draft);
            (ref as React.RefObject<BottomSheetModal | null>).current?.dismiss();
          }}
        />
      </BottomSheetView>
    </BottomSheetModal>
  );
});
