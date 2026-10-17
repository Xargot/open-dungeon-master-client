// Shared by the home and add-server join forms.
export async function submitJoin(
  open: () => Promise<string>,
  button: { disabled: boolean },
  error: { textContent: string | null },
  onError?: () => void,
): Promise<void> {
  button.disabled = true;
  error.textContent = "";
  let message: string;
  try {
    message = await open();
  } catch {
    message = "Could not open that invitation. Try again.";
  }
  button.disabled = false;
  if (message) {
    error.textContent = message;
    onError?.();
  }
}
