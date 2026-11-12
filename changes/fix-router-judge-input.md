Fixed

- Model router: reminder blocks (`<system-reminder>...</system-reminder>`) are stripped per turn before the judge sees the user message; text beside a tool result is kept, and a turn left empty (tool result with reminder appended) yields to the user message before it. Roleless Responses `type: "message"` items are recognized as user messages.
