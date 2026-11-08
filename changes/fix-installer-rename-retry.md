Fixed

- `install.ps1` retries renaming `cliproxy.exe` up to three times when another process briefly holds it, instead of failing a `-BinaryOnly` upgrade with "The process cannot access the file".
