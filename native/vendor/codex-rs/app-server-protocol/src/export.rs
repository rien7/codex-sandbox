use anyhow::Context;
use anyhow::Result;
use schemars::JsonSchema;
use schemars::schema_for;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

/** Minimal schema export support kept for protocol schema helper compilation. */
#[derive(Clone)]
pub struct GeneratedSchema {
    namespace: Option<String>,
    logical_name: String,
    value: Value,
    in_v1_dir: bool,
}

#[allow(dead_code)]
impl GeneratedSchema {
    pub(crate) fn namespace(&self) -> Option<&str> {
        self.namespace.as_deref()
    }

    pub(crate) fn logical_name(&self) -> &str {
        &self.logical_name
    }

    pub(crate) fn value(&self) -> &Value {
        &self.value
    }

    pub(crate) fn in_v1_dir(&self) -> bool {
        self.in_v1_dir
    }
}

fn write_pretty_json(path: PathBuf, value: &impl Serialize) -> Result<()> {
    let json = serde_json::to_vec_pretty(value)
        .with_context(|| format!("Failed to serialize JSON schema to {}", path.display()))?;
    fs::write(&path, json).with_context(|| format!("Failed to write {}", path.display()))?;
    Ok(())
}

fn split_namespace(name: &str) -> (Option<&str>, &str) {
    name.split_once("::")
        .map_or((None, name), |(ns, rest)| (Some(ns), rest))
}

pub(crate) fn write_json_schema<T>(out_dir: &Path, name: &str) -> Result<GeneratedSchema>
where
    T: JsonSchema,
{
    let file_stem = name.trim();
    let (raw_namespace, logical_name) = split_namespace(file_stem);
    let schema = schema_for!(T);
    let schema_value = serde_json::to_value(schema)?;

    let out_path = if let Some(namespace) = raw_namespace {
        let namespace_dir = out_dir.join(namespace);
        fs::create_dir_all(&namespace_dir)
            .with_context(|| format!("Failed to create {}", namespace_dir.display()))?;
        namespace_dir.join(format!("{logical_name}.json"))
    } else {
        out_dir.join(format!("{file_stem}.json"))
    };

    write_pretty_json(out_path, &schema_value)
        .with_context(|| format!("Failed to write JSON schema for {file_stem}"))?;

    let namespace = match raw_namespace {
        Some("v1") | None => None,
        Some(namespace) => Some(namespace.to_string()),
    };

    Ok(GeneratedSchema {
        namespace,
        logical_name: logical_name.to_string(),
        value: schema_value,
        in_v1_dir: raw_namespace == Some("v1"),
    })
}
