use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkPermissions {
    pub enabled: Option<bool>,
}

impl NetworkPermissions {
    pub fn is_enabled(&self) -> bool {
        self.enabled.unwrap_or(false)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionProfile {
    pub network: Option<NetworkPermissions>,
}

impl PermissionProfile {
    pub fn is_empty(&self) -> bool {
        self.network.is_none()
    }
}
