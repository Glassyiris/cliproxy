Fixed

- A credential batch upload of more documents than the open-file limit, such as 2000 documents under the common 1024 limit, now succeeds instead of failing with `store_failed`.
