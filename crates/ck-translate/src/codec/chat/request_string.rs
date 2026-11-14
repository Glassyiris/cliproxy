use super::*;

impl Ingress {
    pub(super) fn string_format(
        &mut self,
        owner: &mut Writer,
        parent: usize,
        wire: json::Node,
    ) -> Result<Option<(media::Encoding, &'static str, Option<usize>)>> {
        let parent_node = self.document.node(parent)?;
        let mut carrier = None;
        if let (Some(name), Some(key), Some(part)) = (parent_node.name, wire.key, parent_node.parent) {
            for (native, field, kind) in [
                ("input_audio", "data", "audio"),
                ("image_url", "url", "image"),
                ("file", "file_data", "document"),
            ] {
                if self.document.name_is(name, native)?
                    && json::string_is(self.document.input(), key, field)?
                    && let Some(content) = self.document.node(part)?.parent
                    && matches!(self.document.node(content)?.value, Value::Array)
                    && let Some(name) = self.document.node(content)?.name
                    && self.document.name_is(name, "content")?
                    && let Some(message) = self.document.node(content)?.parent
                    && let Some(messages) = self.document.node(message)?.parent
                    && self.document.node(messages)?.parent == Some(self.document.root())
                    && matches!(self.document.node(messages)?.value, Value::Array)
                    && let Some(name) = self.document.node(messages)?.name
                    && self.document.name_is(name, "messages")?
                {
                    let Some(ty) = self.document.member(part, "type")? else {
                        return Ok(None);
                    };
                    if self.document.string_is(ty, native)? {
                        carrier = Some((native, kind));
                    }
                }
            }
        }
        let Some((native, kind)) = carrier else {
            if wire.validated_end - wire.span.start <= 1024 {
                return Ok(None);
            }
            let mime = self.document.add(None, Value::Text("text/plain;charset=utf-8"))?;
            return Ok(Some((media::Encoding::Utf8, "text", Some(mime))));
        };
        if native == "input_audio" {
            return Ok(Some((media::Encoding::Base64, kind, None)));
        }
        let span = codec::source::Span {
            start: wire.span.start + 1,
            end: wire.validated_end,
        };
        match media::data_uri_prefix(owner, self.document.input(), span)? {
            media::DataUriPrefix::Incomplete => Ok(None),
            media::DataUriPrefix::Plain if native == "file" => Ok(Some((media::Encoding::Base64, kind, None))),
            media::DataUriPrefix::Plain => {
                if wire.validated_end - wire.span.start <= 1024 {
                    return Ok(None);
                }
                let mime = self.document.add(None, Value::Text("text/plain;charset=utf-8"))?;
                Ok(Some((media::Encoding::Utf8, "text", Some(mime))))
            }
            media::DataUriPrefix::Encoded { encoding, mime } => {
                let mime = self.document.import_json(owner, mime)?;
                Ok(Some((encoding, kind, Some(mime))))
            }
        }
    }
}
