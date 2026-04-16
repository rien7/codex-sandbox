use crate::models::PermissionProfile;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EscalationPermissions {
    PermissionProfile(PermissionProfile),
}

pub type Permissions = EscalationPermissions;
