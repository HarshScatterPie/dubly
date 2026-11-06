// For a card or panel that has to stay a <div> (it holds buttons of its own): reachable by keyboard and announced as a button, like the real thing.
export function pressable(onPress: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: { key: string; target: unknown; currentTarget: unknown; preventDefault: () => void }) => {
      // Only the card's own key presses: Enter on a button inside it belongs to that button.
      if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
        e.preventDefault();
        onPress();
      }
    },
  };
}
