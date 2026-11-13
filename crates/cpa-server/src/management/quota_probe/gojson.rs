//! Go `encoding/json` for the quota probe's normalized quota and the `quota/fetch`
//! request body.
//!
//! Encoding follows `json.Marshal`: fields in declaration order, `omitempty`,
//! HTML-escaped strings. Decoding follows `json.Unmarshal`: a key matches its field
//! exactly or, failing that, case-insensitively; unknown keys are ignored; the last
//! duplicate wins; `null` leaves scalars alone and clears slices; numbers into integer
//! fields must be integer literals.
//!
//! Decoding walks a [`Node`] tree that keeps every object member and number literal.
//! Structs are declared with [`go_struct!`].
//!
//! ponytail: an empty slice encodes as `null` (Go's nil).

use std::collections::BTreeMap;
use std::fmt;

mod node;
pub(crate) use node::{Node, parse};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DecodeError(pub String);

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DecodeError {}

/// A value with Go `encoding/json` semantics.
pub(crate) trait GoJson: Sized + Default {
    /// Go type name, for error messages.
    const GO_TYPE: &'static str;
    /// The Go type as decode errors spell it; containers name their element type
    /// (`[]string`, `map[string]interface {}`).
    fn go_type() -> String {
        Self::GO_TYPE.to_owned()
    }
    /// Appends `json.Marshal` output.
    fn encode(&self, out: &mut Vec<u8>);
    /// `json.Unmarshal` into a zero value.
    fn decode(v: &Node) -> Result<Self, DecodeError> {
        let mut out = Self::default();
        out.decode_into(v)?;
        Ok(out)
    }
    /// `json.Unmarshal` into an existing value. `null` resets slices, maps, pointers and
    /// `any`, and leaves everything else alone.
    fn decode_into(&mut self, v: &Node) -> Result<(), DecodeError> {
        if v.is_null() {
            if Self::NULL_CLEARS {
                *self = Self::default();
            }
            return Ok(());
        }
        *self = Self::decode_value(v)?;
        Ok(())
    }
    /// Decodes a non-null value from scratch. Implement this or [`Self::decode_into`].
    fn decode_value(v: &Node) -> Result<Self, DecodeError> {
        let mut out = Self::default();
        out.decode_into(v)?;
        Ok(out)
    }
    /// Go `omitempty`: false, 0, "", nil or empty slices and maps, nil pointers. Structs
    /// (including `time.Time`) are never empty.
    fn is_empty(&self) -> bool;
    /// Whether `null` resets the field (slices, maps, pointers, `any`); scalars and
    /// structs keep their value.
    const NULL_CLEARS: bool = false;
}

/// `json.Marshal`.
pub(crate) fn to_vec<T: GoJson>(v: &T) -> Vec<u8> {
    let mut out = Vec::new();
    v.encode(&mut out);
    out
}

fn kind(v: &Node) -> &'static str {
    match v {
        Node::Null => "null",
        Node::Bool(_) => "bool",
        Node::Number(_) => "number",
        Node::String(_) => "string",
        Node::Array(_) => "array",
        Node::Object(_) => "object",
    }
}

/// A value of the wrong JSON kind for `go_type`. Go names a number without its
/// literal here; [`number_error`] is the numeric-range case that includes it.
pub(crate) fn type_error(v: &Node, go_type: &str) -> DecodeError {
    let what = match v {
        Node::Number(_) => "number",
        other => kind(other),
    };
    DecodeError(format!("json: cannot unmarshal {what} into Go value of type {go_type}"))
}

/// A number that does not fit the numeric `go_type` (Go `"number " + literal`).
pub(crate) fn number_error(literal: &str, go_type: &str) -> DecodeError {
    DecodeError(format!(
        "json: cannot unmarshal number {literal} into Go value of type {go_type}"
    ))
}

/// Adds the struct field to a decode error, like Go's `UnmarshalTypeError`: the
/// innermost struct's name and the field path from the outermost struct (array
/// indexes and map keys are not part of it).
pub(crate) fn in_field(err: DecodeError, strukt: &str, field: &str) -> DecodeError {
    if let Some((head, ty)) = err.0.split_once(" into Go value of type ") {
        return DecodeError(format!("{head} into Go struct field {strukt}.{field} of type {ty}"));
    }
    // A field of a nested struct: this field goes in front of its path.
    if let Some((head, rest)) = err.0.split_once(" into Go struct field ")
        && let Some((inner, path)) = rest.split_once('.')
    {
        return DecodeError(format!("{head} into Go struct field {inner}.{field}.{path}"));
    }
    err
}

/// Writes one JSON object field by field.
pub(crate) struct ObjWriter<'a> {
    out: &'a mut Vec<u8>,
    first: bool,
}

impl<'a> ObjWriter<'a> {
    pub fn begin(out: &'a mut Vec<u8>) -> Self {
        out.push(b'{');
        Self { out, first: true }
    }

    fn key(&mut self, name: &str) {
        if !self.first {
            self.out.push(b',');
        }
        self.first = false;
        cpa_common::json::marshal_str(self.out, name.as_bytes(), true);
        self.out.push(b':');
    }

    pub fn field<T: GoJson>(&mut self, name: &str, v: &T, omitempty: bool) {
        if omitempty && v.is_empty() {
            return;
        }
        self.key(name);
        v.encode(self.out);
    }

    pub fn end(self) {
        self.out.push(b'}');
    }
}

/// A Go struct: encodes its fields in order and decodes them by name.
pub(crate) trait GoStruct: GoJson {
    fn encode_fields(&self, w: &mut ObjWriter<'_>);
    /// Decodes `v` into the field named `key` (exact match first, then
    /// case-insensitive). `None` when no field matches.
    fn decode_field(&mut self, key: &str, v: &Node) -> Option<Result<(), DecodeError>>;
}

/// Decodes an object into a fresh struct.
pub(crate) fn decode_struct<T: GoStruct>(v: &Node) -> Result<T, DecodeError> {
    let mut out = T::default();
    decode_struct_into(&mut out, v)?;
    Ok(out)
}

/// Decodes an object member by member into an existing struct; later duplicates decode
/// over earlier ones.
pub(crate) fn decode_struct_into<T: GoStruct>(out: &mut T, v: &Node) -> Result<(), DecodeError> {
    match v {
        Node::Null => Ok(()),
        Node::Object(members) => {
            // Go keeps decoding after a type mismatch and reports the first one.
            let mut first_err = None;
            for (key, value) in members {
                if let Some(Err(e)) = out.decode_field(key, value) {
                    first_err.get_or_insert(e);
                }
            }
            first_err.map_or(Ok(()), Err)
        }
        other => Err(type_error(other, &T::go_type())),
    }
}

/// Declares a Go struct with its wire names. Append `omitempty` after a name for Go's
/// `,omitempty`.
///
/// ```ignore
/// go_struct! {
///     pub struct PayloadResponse("pluginapi.PayloadResponse") {
///         "Body" => body: Bytes,
///         "path" omitempty => path: String,
///     }
/// }
/// ```
macro_rules! go_struct {
    (
        $(#[$meta:meta])*
        pub struct $name:ident ($go_type:literal) {
            $( $(#[$fmeta:meta])* $wire:literal $($omit:ident)? => $field:ident : $ty:ty ),* $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Default, PartialEq)]
        pub struct $name {
            $( $(#[$fmeta])* pub $field: $ty, )*
        }

        impl $crate::management::quota_probe::gojson::GoJson for $name {
            const GO_TYPE: &'static str = $go_type;
            fn encode(&self, out: &mut Vec<u8>) {
                let mut w = $crate::management::quota_probe::gojson::ObjWriter::begin(out);
                $crate::management::quota_probe::gojson::GoStruct::encode_fields(self, &mut w);
                w.end();
            }
            fn decode_into(&mut self, v: &$crate::management::quota_probe::gojson::Node) -> Result<(), $crate::management::quota_probe::gojson::DecodeError> {
                $crate::management::quota_probe::gojson::decode_struct_into(self, v)
            }
            fn is_empty(&self) -> bool {
                false
            }
        }

        impl $crate::management::quota_probe::gojson::GoStruct for $name {
            #[allow(unused_variables)]
            fn encode_fields(&self, w: &mut $crate::management::quota_probe::gojson::ObjWriter<'_>) {
                $( w.field($wire, &self.$field, $crate::management::quota_probe::gojson::go_struct!(@omit $($omit)?)); )*
            }
            #[allow(unused_variables)]
            fn decode_field(
                &mut self,
                key: &str,
                v: &$crate::management::quota_probe::gojson::Node,
            ) -> Option<Result<(), $crate::management::quota_probe::gojson::DecodeError>> {
                $(
                    if key == $wire {
                        return Some($crate::management::quota_probe::gojson::decode_field_value(&mut self.$field, v, $go_type, $wire));
                    }
                )*
                $(
                    if key.eq_ignore_ascii_case($wire) {
                        return Some($crate::management::quota_probe::gojson::decode_field_value(&mut self.$field, v, $go_type, $wire));
                    }
                )*
                None
            }
        }
    };
    (@omit omitempty) => { true };
    (@omit) => { false };
}
pub(crate) use go_struct;

/// Decodes one field into its current value.
pub(crate) fn decode_field_value<T: GoJson>(
    slot: &mut T,
    v: &Node,
    strukt: &str,
    field: &str,
) -> Result<(), DecodeError> {
    slot.decode_into(v)
        .map_err(|e| in_field(e, strukt.rsplit('.').next().unwrap_or(strukt), field))
}

// ----------------------------------------------------------------------------------------
// Scalars

impl GoJson for String {
    const GO_TYPE: &'static str = "string";
    fn encode(&self, out: &mut Vec<u8>) {
        cpa_common::json::marshal_str(out, self.as_bytes(), true);
    }
    fn decode_value(v: &Node) -> Result<Self, DecodeError> {
        match v {
            Node::String(s) => Ok(s.clone()),
            other => Err(type_error(other, Self::GO_TYPE)),
        }
    }
    fn is_empty(&self) -> bool {
        self.is_empty()
    }
}

impl GoJson for bool {
    const GO_TYPE: &'static str = "bool";
    fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(if *self { b"true" } else { b"false" });
    }
    fn decode_value(v: &Node) -> Result<Self, DecodeError> {
        match v {
            Node::Bool(b) => Ok(*b),
            other => Err(type_error(other, Self::GO_TYPE)),
        }
    }
    fn is_empty(&self) -> bool {
        !*self
    }
}

macro_rules! go_int {
    ($t:ty, $go:literal) => {
        impl GoJson for $t {
            const GO_TYPE: &'static str = $go;
            fn encode(&self, out: &mut Vec<u8>) {
                out.extend_from_slice(self.to_string().as_bytes());
            }
            /// Go parses the literal with `strconv.ParseInt`/`ParseUint`: `1.0`, `1e2` and
            /// out-of-range values are errors.
            fn decode_value(v: &Node) -> Result<Self, DecodeError> {
                match v {
                    Node::Number(n) => n.parse::<$t>().map_err(|_| number_error(n, Self::GO_TYPE)),
                    other => Err(type_error(other, Self::GO_TYPE)),
                }
            }
            fn is_empty(&self) -> bool {
                *self == 0
            }
        }
    };
}

// Go `int` has the platform's pointer width, like `isize`.
go_int!(isize, "int");
go_int!(i64, "int64");
go_int!(i32, "int32");
go_int!(u32, "uint32");
go_int!(u64, "uint64");

impl GoJson for f64 {
    const GO_TYPE: &'static str = "float64";
    fn encode(&self, out: &mut Vec<u8>) {
        // json.Marshal rejects NaN and Inf; the host never produces them.
        out.extend_from_slice(
            cpa_common::json::json_float(*self)
                .unwrap_or_else(|| "0".into())
                .as_bytes(),
        );
    }
    fn decode_value(v: &Node) -> Result<Self, DecodeError> {
        match v {
            Node::Number(n) => node::parse_f64(n),
            other => Err(type_error(other, Self::GO_TYPE)),
        }
    }
    fn is_empty(&self) -> bool {
        *self == 0.0
    }
}

// ----------------------------------------------------------------------------------------
// Containers

/// A slice: decoding reuses existing elements and truncates to the array's length.
impl<T: GoJson> GoJson for Vec<T> {
    const GO_TYPE: &'static str = "slice";
    const NULL_CLEARS: bool = true;
    fn go_type() -> String {
        format!("[]{}", T::go_type())
    }
    fn encode(&self, out: &mut Vec<u8>) {
        if self.is_empty() {
            out.extend_from_slice(b"null");
            return;
        }
        encode_items(self, out);
    }
    fn decode_into(&mut self, v: &Node) -> Result<(), DecodeError> {
        match v {
            Node::Null => {
                self.clear();
                Ok(())
            }
            Node::Array(items) => {
                let mut first_err = None;
                for (i, item) in items.iter().enumerate() {
                    if i == self.len() {
                        self.push(T::default());
                    }
                    if let Err(e) = self[i].decode_into(item) {
                        first_err.get_or_insert(e);
                    }
                }
                self.truncate(items.len());
                first_err.map_or(Ok(()), Err)
            }
            other => Err(type_error(other, &Self::go_type())),
        }
    }
    fn is_empty(&self) -> bool {
        Vec::is_empty(self)
    }
}

fn encode_items<T: GoJson>(items: &[T], out: &mut Vec<u8>) {
    out.push(b'[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        item.encode(out);
    }
    out.push(b']');
}

/// A pointer: `null` makes it nil; a value decodes into the existing pointee.
impl<T: GoJson> GoJson for Option<T> {
    const GO_TYPE: &'static str = T::GO_TYPE;
    const NULL_CLEARS: bool = true;
    fn go_type() -> String {
        T::go_type()
    }
    fn encode(&self, out: &mut Vec<u8>) {
        match self {
            None => out.extend_from_slice(b"null"),
            Some(v) => v.encode(out),
        }
    }
    fn decode_into(&mut self, v: &Node) -> Result<(), DecodeError> {
        if v.is_null() {
            *self = None;
            return Ok(());
        }
        self.get_or_insert_with(T::default).decode_into(v)
    }
    fn is_empty(&self) -> bool {
        self.is_none()
    }
}

/// Go `http.Header`.
pub(crate) type Header = BTreeMap<String, Vec<String>>;

/// Go `strconv.ParseFloat(s, 64)`: out of range is an error rather than ±Inf, NaN takes
/// no sign, and underscores may separate digits.
/// ponytail: Go's hexadecimal form (`0x1p-2`) is rejected; plugin flags are decimal in
/// practice. Upgrade by porting `atofHex` if a plugin needs it.
pub(crate) fn parse_float(s: &str) -> Option<f64> {
    let unsigned = s.strip_prefix(['+', '-']).unwrap_or(s);
    if unsigned.len() != s.len() && unsigned.eq_ignore_ascii_case("nan") {
        return None;
    }
    let digits;
    let text = if s.contains('_') {
        if !underscore_ok(s) {
            return None;
        }
        digits = s.replace('_', "");
        digits.as_str()
    } else {
        s
    };
    let f = text.parse::<f64>().ok()?;
    let literal_inf = unsigned.to_ascii_lowercase().starts_with("inf");
    (!f.is_infinite() || literal_inf).then_some(f)
}

/// Go `strconv.underscoreOK` for a decimal number: each underscore sits between digits.
fn underscore_ok(s: &str) -> bool {
    let s = s.strip_prefix(['+', '-']).unwrap_or(s);
    let mut saw = '^';
    for c in s.chars() {
        if c.is_ascii_digit() {
            saw = '0';
        } else if c == '_' {
            if saw != '0' {
                return false;
            }
            saw = '_';
        } else if saw == '_' {
            return false;
        } else {
            saw = '!';
        }
    }
    saw != '_'
}
