import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetTextInput,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { forwardRef, useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { radius } from '@avanvu/core';
import { useTheme } from '@/theme/theme';
import { Button } from './Button';
import { Text } from './Text';

export interface EditField {
  key: string;
  label: string;
  value: string;
  max: number;
  multiline?: boolean;
}

interface Props {
  title: string;
  fields: EditField[];
  canSave: (values: Record<string, string>) => boolean;
  onSave: (values: Record<string, string>) => void;
  onRemove?: () => void;
}

/** Edit-in-a-sheet for the summary card: labelled inputs, Save, and an optional Remove (SPEC §4.3). */
export const EditSheet = forwardRef<BottomSheetModal, Props>(function EditSheet(
  { title, fields, canSave, onSave, onRemove },
  ref,
) {
  const { colors } = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => setValues(Object.fromEntries(fields.map((f) => [f.key, f.value]))), [fields]);
  const backdrop = useCallback(
    (p: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.5} />
    ),
    [],
  );
  const close = () => (ref as React.RefObject<BottomSheetModal | null>).current?.dismiss();
  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={['65%', '92%']}
      enableDynamicSizing={false}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      backdropComponent={backdrop}
      backgroundStyle={{
        backgroundColor: colors.surface,
        borderTopLeftRadius: radius.card,
        borderTopRightRadius: radius.card,
      }}
      handleIndicatorStyle={{ backgroundColor: colors.borderStrong }}
    >
      <BottomSheetScrollView
        contentContainerStyle={{ padding: 20, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text variant="title2" accessibilityRole="header">
          {title}
        </Text>
        {fields.map((f) => (
          <View key={f.key} style={{ gap: 6 }}>
            <Text variant="caption" tone="secondary">
              {f.label}
            </Text>
            <BottomSheetTextInput
              accessibilityLabel={f.label}
              value={values[f.key] ?? ''}
              onChangeText={(t) => setValues((v) => ({ ...v, [f.key]: t.slice(0, f.max) }))}
              multiline={!!f.multiline}
              style={{
                minHeight: f.multiline ? 104 : 52,
                borderRadius: radius.input,
                paddingHorizontal: 16,
                paddingVertical: 12,
                fontSize: 17,
                textAlignVertical: 'top',
                color: colors.textPrimary,
                backgroundColor: colors.surfaceRaised,
                borderWidth: 1,
                borderColor: colors.borderStrong,
              }}
            />
          </View>
        ))}
        <Button
          label="Save"
          disabled={!canSave(values)}
          onPress={() => {
            onSave(values);
            close();
          }}
        />
        {onRemove ? (
          <Button
            label="Remove"
            kind="text"
            onPress={() => {
              onRemove();
              close();
            }}
          />
        ) : null}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
});
