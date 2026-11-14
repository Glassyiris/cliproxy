use super::*;
use crate::codec::media::{Encoding, Media};

impl State {
    pub(super) fn media_value(
        &mut self,
        owner: &mut Writer,
        input: &Document,
        value: usize,
        scope: Scope,
        field: &'static str,
    ) -> Result<bool> {
        if self.finish_published(owner, input, value)? {
            return Ok(true);
        }
        let audio = field == "audio";
        let native_data = if audio {
            input.member(value, "data")?
        } else if let Some(image) = input.member(value, "image_url")? {
            input.member(image, "url")?
        } else {
            None
        };
        let Some(native_data) = native_data else {
            return Ok(false);
        };
        let Value::String(text) = input.node(native_data)?.value else {
            return Err(Error::Schema);
        };
        let (encoding, mime_lease) = if audio {
            (Encoding::Base64, None)
        } else {
            let Some((encoding, mime)) = super::super::request_content::data_uri_metadata(input, owner, native_data)?
            else {
                return Ok(false);
            };
            (encoding, Some(mime))
        };
        let transcript = if audio {
            match input.member(value, "transcript")? {
                Some(text) if !matches!(input.node(text)?.value, Value::Null) => {
                    super::super::request::require_string(input, text)?;
                    Some(text)
                }
                _ => None,
            }
        } else {
            None
        };
        let mut attributes = mapped_document(owner, |e| {
            e.bytes(b"{\"field\":")?;
            e.string(field)?;
            e.bytes(b",\"value\":{")?;
            if audio {
                e.bytes(b"\"data\":null")?;
                members(
                    input,
                    value,
                    e,
                    if transcript.is_some() {
                        &["data", "transcript"]
                    } else {
                        &["data"]
                    },
                )?;
            } else {
                let image = input.required(value, "image_url")?;
                e.bytes(b"\"image_url\":{\"url\":null")?;
                members(input, image, e, &["url"])?;
                e.bytes(b"}")?;
                members(input, value, e, &["image_url"])?;
            }
            e.bytes(b"}}")
        })?;
        let mime = if let Some(mime) = mime_lease {
            Some(attributes.import_json(owner, mime)?)
        } else if let Some(format) = input.member(value, "format")? {
            if input.string_is(format, "wav")? {
                Some(attributes.add(None, Value::Text("audio/wav"))?)
            } else if input.string_is(format, "mp3")? {
                Some(attributes.add(None, Value::Text("audio/mpeg"))?)
            } else {
                None
            }
        } else {
            None
        };
        let media = Media {
            node: native_data,
            id: media::local_id(b'm', self.serial)?,
            data: Some(text),
            encoding,
            kind: if audio { "audio" } else { "image" },
            mime: None,
        };
        self.serial = self.serial.checked_add(1).ok_or(Error::Limit)?;
        let fragment = if audio {
            let position = self
                .choices
                .iter()
                .position(|choice| Some(choice.index) == scope.choice_index)
                .ok_or(Error::Schema)?;
            Some(&mut self.choices[position].audio)
        } else {
            None
        };
        media::publish_with_attributes(
            input,
            media,
            &mut self.emitter,
            owner,
            (scope, fragment),
            Some(media::Attributes {
                document: &attributes,
                value: attributes.root(),
                mime,
            }),
            transcript,
        )?;
        Ok(true)
    }

    pub(super) fn array_field(
        &mut self,
        owner: &mut Writer,
        doc: &Document,
        field: usize,
        position: usize,
        name: &'static str,
    ) -> Result<()> {
        if !matches!(doc.node(field)?.value, Value::Array) {
            return Err(Error::Schema);
        }
        if doc.node(field)?.first.is_none() {
            return self.empty_array(owner, position, name);
        }
        for part in doc.children(field)? {
            let scope = if let Some(scope) = self.published_scope(part) {
                scope
            } else {
                let mut scope = self.scope(position);
                scope.block_index = Some(self.choices[position].next_block);
                self.choices[position].next_block += 1;
                self.emitter.emit(
                    owner,
                    Kind::BlockStart,
                    scope,
                    |e| e.bytes(b",\"kind\":\"content\""),
                    |_| Ok(()),
                )?;
                scope
            };
            if !self.media_value(owner, doc, part, scope, name)? {
                self.emitter.emit(
                    owner,
                    Kind::Chunk,
                    scope,
                    |e| {
                        base(self.base.as_ref().ok_or(Error::Schema)?, e)?;
                        e.bytes(b",\"choices\":[{\"index\":")?;
                        e.unsigned(scope.choice_index.ok_or(Error::Schema)?)?;
                        e.bytes(b",\"delta\":{")?;
                        e.string(name)?;
                        e.bytes(b":[")?;
                        doc.write(part, e)?;
                        e.bytes(b"]},\"finish_reason\":null}]")
                    },
                    |_| Ok(()),
                )?;
            }
            self.emitter
                .emit(owner, Kind::BlockEnd, scope, |_| Ok(()), |_| Ok(()))?;
        }
        Ok(())
    }

    pub(super) fn annotations(
        &mut self,
        owner: &mut Writer,
        doc: &Document,
        field: usize,
        position: usize,
    ) -> Result<()> {
        if !matches!(doc.node(field)?.value, Value::Array) {
            return Err(Error::Schema);
        }
        if doc.node(field)?.first.is_none() {
            return self.empty_array(owner, position, "annotations");
        }
        for annotation in doc.children(field)? {
            self.emitter.emit(
                owner,
                Kind::Annotation,
                self.scope(position),
                |e| {
                    e.bytes(b",\"kind\":\"chat\",\"value\":")?;
                    doc.write(annotation, e)
                },
                |_| Ok(()),
            )?;
        }
        Ok(())
    }
}

impl State {
    pub(super) fn empty_array(&mut self, owner: &mut Writer, position: usize, name: &'static str) -> Result<()> {
        let scope = self.scope(position);
        self.emitter.emit(
            owner,
            Kind::Chunk,
            scope,
            |e| {
                base(self.base.as_ref().ok_or(Error::Schema)?, e)?;
                e.bytes(b",\"choices\":[{\"index\":")?;
                e.unsigned(scope.choice_index.ok_or(Error::Schema)?)?;
                e.bytes(b",\"delta\":{")?;
                e.string(name)?;
                e.bytes(b":[]},\"finish_reason\":null}]")
            },
            |_| Ok(()),
        )?;
        Ok(())
    }
}
