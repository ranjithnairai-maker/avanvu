import { forwardRef, useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetModal,
  BottomSheetTextInput,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { radius } from '@avanvu/core';
import { useTheme } from '@/theme/theme';
import { Text } from './Text';

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  title: string;
  options: readonly SelectOption[];
  value: string | null;
  onSelect: (value: string) => void;
  searchable?: boolean;
}

/** Never a web-style dropdown: a bottom sheet with 56 pt rows and a check on the selected item (SPEC §7.5). */
export const SelectSheet = forwardRef<BottomSheetModal, Props>(function SelectSheet(
  { title, options, value, onSelect, searchable },
  ref,
) {
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const data = useMemo(
    () => options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase())),
    [options, query],
  );
  const backdrop = useCallback(
    (p: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.5} />
    ),
    [],
  );

  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={['60%', '90%']}
      enableDynamicSizing={false}
      backdropComponent={backdrop}
      backgroundStyle={{
        backgroundColor: colors.surface,
        borderTopLeftRadius: radius.card,
        borderTopRightRadius: radius.card,
      }}
      handleIndicatorStyle={{ backgroundColor: colors.borderStrong }}
    >
      <View style={{ paddingHorizontal: 20, paddingBottom: 8, gap: 12 }}>
        <Text variant="title2" accessibilityRole="header">
          {title}
        </Text>
        {searchable ? (
          <BottomSheetTextInput
            accessibilityLabel={`Search ${title}`}
            placeholder="Search"
            placeholderTextColor={colors.textTertiary}
            value={query}
            onChangeText={setQuery}
            style={{
              minHeight: 52,
              borderRadius: radius.input,
              paddingHorizontal: 16,
              fontSize: 17,
              color: colors.textPrimary,
              backgroundColor: colors.surfaceRaised,
              borderWidth: 1,
              borderColor: colors.borderStrong,
            }}
          />
        ) : null}
      </View>
      <BottomSheetFlatList
        data={data}
        keyExtractor={(o: SelectOption) => o.value}
        renderItem={({ item }: { item: SelectOption }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: item.value === value }}
            onPress={() => {
              Haptics.selectionAsync();
              onSelect(item.value);
              (ref as React.RefObject<BottomSheetModal | null>).current?.dismiss();
            }}
            style={{
              minHeight: 56,
              paddingHorizontal: 20,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text variant="body">{item.label}</Text>
            {item.value === value ? <Text tone="accent">✓</Text> : null}
          </Pressable>
        )}
      />
    </BottomSheetModal>
  );
});
