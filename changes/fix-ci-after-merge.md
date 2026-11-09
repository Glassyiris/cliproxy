Changed

- The dashboard is embedded gzip-compressed, which cuts it from 3.3 MB to 1.06 MB in the binary. The server sends it compressed to browsers that accept it, and decompresses it for the rest. (#3)
- The dashboard no longer ships `.woff` font fallbacks; every supported browser loads woff2. (#3)
