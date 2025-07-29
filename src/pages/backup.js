import cockpit from 'cockpit';
import classNames from 'classnames';
import React, { useEffect, useState } from 'react';
import { Badge, Button, Card, Col, Alert as ReactAlert, Row, Table, Modal, Spinner, Form } from 'react-bootstrap';
import Snackbar from '@mui/material/Snackbar';
import MuiAlert from '@mui/material/Alert';

const _ = cockpit.gettext;

// 系统配置常量
const CONFIG = {
    MAX_MANUAL_BACKUPS: 2,
    API_URL: "https://fc-snapshot-api-jjckkljpbf.cn-hongkong-vpc.fcapp.run",
    METADATA_BASE_URL: "100.100.100.200",
    REQUEST_TIMEOUT: 15000
};

// 公共的API调用工具类
class SnapshotAPI {
    // 带超时机制的spawn执行方法
    async executeWithTimeout(script, timeout = CONFIG.REQUEST_TIMEOUT) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(_("Request timed out")));
            }, timeout);

            cockpit.spawn(["/bin/bash", "-c", script], { superuser: "try" })
                .then((result) => {
                    clearTimeout(timeoutId);
                    resolve(result);
                })
                .catch((error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                });
        });
    }

    // 发送HTTP请求的通用方法
    async request(path, data) {
        try {
            const script = `curl -s -X POST ${CONFIG.API_URL}${path} \\
                -H 'Content-Type: application/json' \\
                -d '${JSON.stringify(data)}'`;

            const response = await this.executeWithTimeout(script);

            // 如果响应为空，表示成功（204状态码）
            if (!response.trim()) {
                return { success: true };
            }

            // 尝试解析JSON响应
            let responseData;
            try {
                responseData = JSON.parse(response.trim());
            } catch (parseError) {
                throw new Error(_("Invalid response format") + ": " + response.substring(0, 100));
            }

            return responseData;
        } catch (error) {
            throw new Error(_("Failed to fetch data") + `: ${error.message || error}`);
        }
    }    // 获取快照列表
    async describeSnapshots(instanceId, regionId) {
        return this.request("/DescribeSnapshots", {
            "InstanceId": instanceId,
            "RegionId": regionId
        });
    }

    // 创建快照
    async createSnapshot(diskId, regionId, snapshotName) {
        return this.request("/CreateSnapshot", {
            "DiskId": diskId,
            "RegionId": regionId,
            "SnapshotName": snapshotName
        });
    }

    // 删除快照
    async deleteSnapshot(snapshotId, regionId) {
        return this.request("/DeleteSnapshot", {
            "SnapshotId": snapshotId,
            "RegionId": regionId
        });
    }

    // 恢复快照
    async revertSnapshot(accountId, snapshotId, regionId, diskId, instanceId) {
        return this.request("/RevertSnapshot", {
            "AccountId": accountId,
            "SnapshotId": snapshotId,
            "RegionId": regionId,
            "DiskId": diskId,
            "InstanceId": instanceId
        });
    }
}

// 元数据获取工具类
class MetadataService {
    // 带超时机制的spawn执行方法
    async executeWithTimeout(script, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(_("Metadata request timed out")));
            }, timeout);

            cockpit.spawn(["/bin/bash", "-c", script], { superuser: "try" })
                .then((result) => {
                    clearTimeout(timeoutId);
                    resolve(result);
                })
                .catch((error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                });
        });
    }

    // 使用cockpit.spawn获取元数据的通用方法
    async getMetadata(path) {
        try {
            const script = `curl -s http://${CONFIG.METADATA_BASE_URL}${path}`;
            const response = await this.executeWithTimeout(script);
            return response.trim();
        } catch (error) {
            throw new Error(_("Unable to get metadata") + ': ' + (error.message || error));
        }
    }

    // 获取实例ID
    async getInstanceId() {
        return this.getMetadata("/latest/meta-data/instance-id");
    }

    // 获取区域ID
    async getRegionId() {
        return this.getMetadata("/latest/meta-data/region-id");
    }

    // 获取磁盘ID
    async getDiskId() {
        const disks = await this.getMetadata("/latest/meta-data/disks/");
        return `d-${disks.replace(/\/$/, '')}`; // 删除末尾的 /
    }

    // 获取账号ID
    async getAccountId() {
        return this.getMetadata("/latest/meta-data/owner-account-id");
    }
}

// 创建全局实例
const snapshotAPI = new SnapshotAPI();
const metadataService = new MetadataService();

const MyMuiAlert = React.forwardRef(function Alert(props, ref) {
    return <MuiAlert elevation={6} ref={ref} variant="filled" {...props} />;
});

const RestoreConform = ({ show, onClose, snapshotId, snapshot, onRestoreSuccess }) => {
    const [disable, setDisable] = useState(false);
    const [showAlert, setShowAlert] = useState(false);
    const [alertMessage, setAlertMessage] = useState("");
    const [isConfirmed, setIsConfirmed] = useState(false); // 用于控制确认框

    const handleCloseAlert = (event, reason) => {
        if (reason === 'clickaway') {
            return;
        }
        setShowAlert(false);
        setAlertMessage("");
    };

    const handleRestore = async () => {
        setDisable(true);
        try {
            // 获取所需的元数据
            const [regionId, instanceId, diskId, accountId] = await Promise.all([
                metadataService.getRegionId(),
                metadataService.getInstanceId(),
                metadataService.getDiskId(),
                metadataService.getAccountId()
            ]);

            // 调用恢复快照API
            const result = await snapshotAPI.revertSnapshot(accountId, snapshotId, regionId, diskId, instanceId);

            if (result.Code === 'TaskStarted' && result.TaskId) {
                onClose();
            } else {
                throw new Error(result.Code || "Failed to restore snapshot");
            }
        } catch (error) {
            setShowAlert(true);
            setAlertMessage(error.message);
        } finally {
            setDisable(false);
        }
    };

    const handleClose = () => {
        setIsConfirmed(false); // 重置确认框状态
        onClose();
    };

    // 每次显示弹窗时重置勾选框状态
    useEffect(() => {
        if (show) {
            setIsConfirmed(false);
        }
    }, [show]);

    return (
        <>
            <Modal show={show} onHide={handleClose} size="lg" scrollable="true" backdrop="static" style={{ backgroundColor: "rgba(0,0,0,0.4)" }}>
                <Modal.Header onHide={handleClose} className={classNames('modal-colored-header', 'bg-danger')}>
                    <h4>{_("Restore Backup")}</h4>
                </Modal.Header>
                <Modal.Body className="row">
                    <span style={{ margin: "10px 0px" }}>{_("Are you sure you want to restore this backup? This action will roll back your system to the state of this backup.")}</span>

                    {/* 备份信息样式 */}
                    {snapshot && (
                        <div className="mt-3 mb-4">
                            <div className="d-flex flex-column gap-3">
                                <div className="d-flex align-items-baseline">
                                    <span className="text-muted me-2" style={{ fontWeight: '500' }}>{_("ID")}: </span>
                                    <span style={{ wordBreak: 'break-all' }}>{snapshot.snapshotId}</span>
                                </div>
                                <div className="d-flex align-items-baseline">
                                    <span className="text-muted me-2" style={{ fontWeight: '500' }}>{_("Name")}: </span>
                                    <span>{snapshot.snapshotName || "-"}</span>
                                </div>
                                <div className="d-flex align-items-baseline">
                                    <span className="text-muted me-2" style={{ fontWeight: '500' }}>{_("Type")}: </span>
                                    <span>{snapshot.snapshotType === 'timer' ? _("Automatic Backup") : _("Manual Backup")}</span>
                                </div>
                                <div className="d-flex align-items-baseline">
                                    <span className="text-muted me-2" style={{ fontWeight: '500' }}>{_("Created At")}: </span>
                                    <span>{new Date(snapshot.creationTime).toLocaleString()}</span>
                                </div>
                                <div className="d-flex align-items-baseline">
                                    <span className="text-muted me-2" style={{ fontWeight: '500' }}>{_("Retention Period")}: </span>
                                    <span>{snapshot.retentionDays === undefined || snapshot.retentionDays === -1 ? _("Permanent") : `${snapshot.retentionDays} ${_("days")}`}</span>
                                </div>
                            </div>
                        </div>
                    )}

                    <div style={{ margin: "15px 0px" }} className="alert alert-warning" role="alert">
                        <p style={{ margin: "0px 0px 8px 0px", fontSize: '0.9em', fontWeight: 'bold' }}>{_("Caution:")}</p>
                        <ul style={{ margin: "0px", fontSize: '0.9em', paddingLeft: "20px" }}>
                            <li>{_("Restoring a backup will replace your current system state. All data and changes made after this backup was created will be lost.")}</li>
                            <li>{_("The restoration process may take 5-30 minutes depending on the data size. You can refresh the console to check progress.")}</li>
                            <li>{_("During restoration, the server will be unavailable and all applications will be offline until the process completes.")}</li>
                            <li>{_("Restoration carries risks. If you cannot access the console after an extended period, please contact support through the ticketing system.")}</li>
                        </ul>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", marginTop: "10px" }}>
                        <Form.Check
                            type="checkbox"
                            id="confirm-restore-checkbox"
                            checked={isConfirmed}
                            onChange={() => setIsConfirmed(!isConfirmed)}
                            style={{ marginRight: "10px" }}
                        />
                        <span>{_("I understand the risks and confirm to restore this backup, knowing that all data and changes after this backup will be lost and cannot be recovered.")}</span>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button variant="light" onClick={handleClose} disabled={disable}>
                        {_("Close")}
                    </Button>
                    <Button variant="danger" onClick={handleRestore} disabled={disable || !isConfirmed}>
                        {disable && <Spinner className="spinner-border-sm me-1" tag="span" color="white" />} {_("Restore")}
                    </Button>
                </Modal.Footer>
            </Modal>
            {showAlert && (
                <Snackbar open={showAlert} onClose={handleCloseAlert} anchorOrigin={{ vertical: 'top', horizontal: 'center' }}>
                    <MyMuiAlert onClose={handleCloseAlert} severity="error" sx={{ width: '100%' }}>
                        {alertMessage}
                    </MyMuiAlert>
                </Snackbar>
            )}
        </>
    );
};

const DeleteConform = ({ show, onClose, snapshotId, snapshot, onDeleteSuccess }) => {
    const [disable, setDisable] = useState(false);
    const [showAlert, setShowAlert] = useState(false);
    const [alertMessage, setAlertMessage] = useState("");
    const [isConfirmed, setIsConfirmed] = useState(false); // 新增状态，用于控制确认框

    const handleCloseAlert = (event, reason) => {
        if (reason === 'clickaway') {
            return;
        }
        setShowAlert(false);
        setAlertMessage("");
    };

    const handleDelete = async () => {
        setDisable(true);
        try {
            // 获取区域ID
            const regionId = await metadataService.getRegionId();

            // 调用删除快照API
            const result = await snapshotAPI.deleteSnapshot(snapshotId, regionId);

            if (result.success || (result.snapshotId && result.requestId)) {
                onDeleteSuccess();
                onClose();
            } else {
                throw new Error(result.Code || "Failed to delete snapshot");
            }
        } catch (error) {
            setShowAlert(true);
            setAlertMessage(error.message);
        } finally {
            setDisable(false);
        }
    };

    const handleClose = () => {
        setIsConfirmed(false); // 重置确认框状态
        onClose();
    };

    // 每次显示弹窗时重置勾选框状态
    useEffect(() => {
        if (show) {
            setIsConfirmed(false);
        }
    }, [show]);

    return (
        <>
            <Modal show={show} onHide={handleClose} size="lg" scrollable="true" backdrop="static" style={{ backgroundColor: "rgba(0,0,0,0.4)" }}>
                <Modal.Header onHide={handleClose} className={classNames('modal-colored-header', 'bg-warning')}>
                    <h4>{_("Delete Backup")}</h4>
                </Modal.Header>
                <Modal.Body className="row">
                    <span style={{ margin: "10px 0px" }}>{_("Are you sure you want to delete this backup? This action cannot be undone.")}</span>

                    {/* 备份信息样式 */}
                    {snapshot && (
                        <div className="mt-3 mb-4">
                            <div className="d-flex flex-column gap-3">
                                <div className="d-flex align-items-baseline">
                                    <span className="text-muted me-2" style={{ fontWeight: '500' }}>{_("ID")}: </span>
                                    <span style={{ wordBreak: 'break-all' }}>{snapshot.snapshotId}</span>
                                </div>
                                <div className="d-flex align-items-baseline">
                                    <span className="text-muted me-2" style={{ fontWeight: '500' }}>{_("Name")}: </span>
                                    <span>{snapshot.snapshotName || "-"}</span>
                                </div>
                                <div className="d-flex align-items-baseline">
                                    <span className="text-muted me-2" style={{ fontWeight: '500' }}>{_("Type")}: </span>
                                    <span>{snapshot.snapshotType === 'timer' ? _("Automatic Backup") : _("Manual Backup")}</span>
                                </div>
                                <div className="d-flex align-items-baseline">
                                    <span className="text-muted me-2" style={{ fontWeight: '500' }}>{_("Created At")}: </span>
                                    <span>{new Date(snapshot.creationTime).toLocaleString()}</span>
                                </div>
                                <div className="d-flex align-items-baseline">
                                    <span className="text-muted me-2" style={{ fontWeight: '500' }}>{_("Retention Period")}: </span>
                                    <span>{snapshot.retentionDays === undefined || snapshot.retentionDays === -1 ? _("Permanent") : `${snapshot.retentionDays} ${_("days")}`}</span>
                                </div>
                            </div>
                        </div>
                    )}

                    <div style={{ display: "flex", alignItems: "center", marginTop: "10px" }}>
                        <Form.Check
                            type="checkbox"
                            id="confirm-delete-checkbox"
                            checked={isConfirmed}
                            onChange={() => setIsConfirmed(!isConfirmed)}
                            style={{ marginRight: "10px" }}
                        />
                        <span>{_("I confirm that the backup cannot be recovered after deletion, and the data cannot be retrieved.")}</span>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button variant="light" onClick={handleClose} disabled={disable}>
                        {_("Close")}
                    </Button>
                    <Button variant="warning" onClick={handleDelete} disabled={disable || !isConfirmed}>
                        {disable && <Spinner className="spinner-border-sm me-1" tag="span" color="white" />} {_("Delete")}
                    </Button>
                </Modal.Footer>
            </Modal>
            {showAlert && (
                <Snackbar open={showAlert} onClose={handleCloseAlert} anchorOrigin={{ vertical: 'top', horizontal: 'center' }}>
                    <MyMuiAlert onClose={handleCloseAlert} severity="error" sx={{ width: '100%' }}>
                        {alertMessage}
                    </MyMuiAlert>
                </Snackbar>
            )}
        </>
    );
};

const CreateBackupModal = ({ show, onClose, onCreateSuccess, snapshots }) => {
    const [disable, setDisable] = useState(false);
    const [showAlert, setShowAlert] = useState(false);
    const [alertMessage, setAlertMessage] = useState("");
    const [snapshotName, setSnapshotName] = useState("");
    // 检查手动备份数量
    const manualBackupsCount = snapshots ? snapshots.filter(snapshot => snapshot.snapshotType !== 'timer').length : 0;
    const canCreateBackup = manualBackupsCount < CONFIG.MAX_MANUAL_BACKUPS;

    const handleCloseAlert = (event, reason) => {
        if (reason === 'clickaway') {
            return;
        }
        setShowAlert(false);
        setAlertMessage("");
    };

    const handleCreate = async () => {
        setDisable(true);
        try {
            // 检查是否达到手动备份上限
            if (!canCreateBackup) {
                throw new Error(cockpit.format(_("Cannot create more backups. The limit is $0 manual backups."), CONFIG.MAX_MANUAL_BACKUPS));
            }

            // 获取所需的元数据
            const [regionId, diskId] = await Promise.all([
                metadataService.getRegionId(),
                metadataService.getDiskId()
            ]);

            // 调用创建快照API
            const result = await snapshotAPI.createSnapshot(diskId, regionId, snapshotName);

            if (result.snapshotId && result.requestId) {
                onCreateSuccess();
                onClose();
            } else {
                throw new Error(result.Code || "Failed to create snapshot");
            }
        } catch (error) {
            setShowAlert(true);
            setAlertMessage(error.message);
        } finally {
            setDisable(false);
        }
    };

    const handleClose = () => {
        setSnapshotName(""); // 重置快照名称
        onClose();
    };

    // 验证备份名称
    const isValidSnapshotName = (name) => {
        if (!name || name.trim() === "") return false;
        if (name.length < 2 || name.length > 30) return false;
        if (name.toLowerCase().startsWith('http://') || name.toLowerCase().startsWith('https://') || name.toLowerCase().startsWith('auto')) return false;
        return true;
    };

    useEffect(() => {
        if (show) {
            const now = new Date();
            const formattedDate = now.toISOString().replace(/[-:T]/g, '').slice(0, 12); // 格式化日期时间
            setSnapshotName(`manual-backup-${formattedDate}`);
        }
    }, [show]);

    return (
        <>
            <Modal show={show} onHide={handleClose} size="lg" scrollable="true" backdrop="static" style={{ backgroundColor: "rgba(0,0,0,0.4)" }}>
                <Modal.Header onHide={handleClose} className={classNames('modal-colored-header', !canCreateBackup ? 'bg-warning' : 'bg-primary')}>
                    <h4>{_("Create Backup")}</h4>
                </Modal.Header>
                <Modal.Body className="row">
                    {!canCreateBackup ? (
                        // 当已达到备份上限时，只显示警告信息
                        <div style={{ margin: "10px 0px" }}>
                            <p>{cockpit.format(_("The current version supports up to $0 manual backups."), CONFIG.MAX_MANUAL_BACKUPS)}</p>
                            <p>{_("Please delete some existing backups before creating new ones.")}</p>
                        </div>

                    ) : (
                        // 未达到上限时显示正常的创建表单
                        <>
                            <div className="alert alert-warning" role="alert" style={{ fontSize: '0.9em', fontWeight: 'normal' }}>
                                {cockpit.format(_("Note: The current version supports up to $0 manual backups. Retention period is permanent."), CONFIG.MAX_MANUAL_BACKUPS)}
                            </div>
                            <Form.Group className="mb-3">
                                <Form.Label style={{ fontWeight: 'normal' }}>{_("Backup Name")}</Form.Label>
                                <Form.Control
                                    type="text"
                                    placeholder={_("Enter backup name")}
                                    value={snapshotName}
                                    onChange={(e) => setSnapshotName(e.target.value)}
                                    isInvalid={snapshotName.trim() !== "" && !isValidSnapshotName(snapshotName)}
                                />
                                <Form.Text className="text-muted" style={{ fontSize: '0.8em' }}>
                                    {_("Name length must be 2-30 characters and cannot start with 'http://', 'https://' or 'auto'.")}
                                </Form.Text>
                            </Form.Group>
                            <Form.Group className="mb-3">
                                <Form.Label style={{ fontWeight: 'normal' }}>{_("Retention Period")}</Form.Label>
                                <Form.Check
                                    type="radio"
                                    label={_("Permanent")}
                                    checked
                                    readOnly
                                />
                            </Form.Group>
                        </>
                    )}
                </Modal.Body>
                <Modal.Footer>
                    {!canCreateBackup ? (
                        <Button variant="warning" onClick={handleClose}>
                            {_("Close")}
                        </Button>
                    ) : (
                        <>
                            <Button variant="light" onClick={handleClose} disabled={disable}>
                                {_("Close")}
                            </Button>
                            <Button
                                variant="primary"
                                onClick={handleCreate}
                                disabled={disable || !isValidSnapshotName(snapshotName)}>
                                {disable && <Spinner className="spinner-border-sm me-1" tag="span" color="white" />} {_("Create")}
                            </Button>
                        </>
                    )}
                </Modal.Footer>
            </Modal>
            {showAlert && (
                <Snackbar open={showAlert} onClose={handleCloseAlert} anchorOrigin={{ vertical: 'top', horizontal: 'center' }}>
                    <MyMuiAlert onClose={handleCloseAlert} severity="error" sx={{ width: '100%' }}>
                        {alertMessage}
                    </MyMuiAlert>
                </Snackbar>
            )}
        </>
    );
};

const BackUp = () => {
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [snapshots, setSnapshots] = useState([]);
    const [showDeleteConform, setShowDeleteConform] = useState(false);
    const [showCreateBackup, setShowCreateBackup] = useState(false);
    const [showRestoreConform, setShowRestoreConform] = useState(false);
    const [selectedSnapshotId, setSelectedSnapshotId] = useState(null);
    const [refreshIntervalId, setRefreshIntervalId] = useState(null);

    // 使用 cockpit.http 调用 API
    const getSnapshots = async () => {
        try {
            setLoading(true);
            setError(null);

            // 获取实例ID和区域ID
            const [instanceId, regionId] = await Promise.all([
                metadataService.getInstanceId(),
                metadataService.getRegionId()
            ]);

            // 调用获取快照列表API
            const responseData = await snapshotAPI.describeSnapshots(instanceId, regionId);

            // 检查响应数据并更新状态
            if (responseData.snapshots && responseData.snapshots.snapshot) {
                const newSnapshots = responseData.snapshots.snapshot;
                setSnapshots(newSnapshots);

                // 检查是否有进行中的备份，如果有则开启轮询
                const hasProgressingSnapshot = newSnapshots.some(snapshot =>
                    snapshot.status === "progressing"
                );

                if (hasProgressingSnapshot && !refreshIntervalId) {
                    startProgressPolling();
                } else if (!hasProgressingSnapshot && refreshIntervalId) {
                    stopProgressPolling();
                }
            } else {
                setSnapshots([]);
                if (refreshIntervalId) {
                    stopProgressPolling();
                }
            }

        } catch (error) {
            setError(_("Failed to fetch backup list") + `: ${error.message}`);
            setSnapshots([]);
        } finally {
            setLoading(false);
        }
    };

    // 开始进度轮询
    const startProgressPolling = () => {
        if (refreshIntervalId) return; // 防止重复设置

        const intervalId = setInterval(async () => {
            try {
                // 获取实例ID和区域ID
                const [instanceId, regionId] = await Promise.all([
                    metadataService.getInstanceId(),
                    metadataService.getRegionId()
                ]);

                // 调用获取快照列表API
                const responseData = await snapshotAPI.describeSnapshots(instanceId, regionId);

                if (responseData.snapshots && responseData.snapshots.snapshot) {
                    const newSnapshots = responseData.snapshots.snapshot;
                    setSnapshots(newSnapshots);

                    // 检查是否还有进行中的备份
                    const hasProgressingSnapshot = newSnapshots.some(snapshot =>
                        snapshot.status === "progressing"
                    );

                    if (!hasProgressingSnapshot) {
                        stopProgressPolling();
                    }
                }
            } catch (error) {
                console.error("Progress polling error:", error);
            }
        }, 1000); // 每秒刷新一次

        setRefreshIntervalId(intervalId);
    };

    // 停止进度轮询
    const stopProgressPolling = () => {
        if (refreshIntervalId) {
            clearInterval(refreshIntervalId);
            setRefreshIntervalId(null);
        }
    };

    // 组件加载时获取数据
    useEffect(() => {
        // 添加超时机制
        const timeoutId = setTimeout(() => {
            if (loading) {
                setError(_("Data fetch timeout"));
                setLoading(false);
            }
        }, CONFIG.REQUEST_TIMEOUT); // 使用配置中的超时时间

        getSnapshots().finally(() => {
            clearTimeout(timeoutId);
        });

        // 清理函数
        return () => {
            clearTimeout(timeoutId);
            stopProgressPolling(); // 组件卸载时停止轮询
        };
    }, []);

    // 组件卸载时清理轮询
    useEffect(() => {
        return () => {
            stopProgressPolling();
        };
    }, [refreshIntervalId]);

    // 格式化创建时间
    const formatCreationTime = (isoTime) => {
        const date = new Date(isoTime);
        return date.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    };

    // 获取备份类型
    const getSnapshotType = (snapshotType) => {
        switch (snapshotType) {
            case 'timer':
                return _("Automatic Backup");
            case 'user':
                return _("Manual Backup");
            default:
                return _("Manual Backup");
        }
    };

    // 获取保留期限
    const getRetentionPeriod = (retentionDays) => {
        if (retentionDays === undefined || retentionDays === -1) {
            return _("Permanent");
        }
        return `${retentionDays} ${_("days")}`;
    };

    // 渲染备份状态
    const renderBackupStatus = (snapshot) => {
        if (snapshot.status === "progressing") {
            const progress = snapshot.progress || 0;
            return (
                <div className="d-flex align-items-center text-primary">
                    <Spinner
                        animation="border"
                        size="sm"
                        variant="primary"
                        className="me-2"
                    />
                    <span>{progress}</span>
                </div>
            );
        } else if (snapshot.status === "failed") {
            return (
                <div className="text-danger">
                    <i className="fa fa-exclamation-triangle me-1"></i>
                    {_("Creation Failed")}
                </div>
            );
        } else {
            return (
                <div className="d-flex gap-3">
                    <a
                        href="#"
                        className="text-primary text-decoration-none"
                        onClick={(e) => {
                            e.preventDefault();
                            setShowRestoreConform(true);
                            setSelectedSnapshotId(snapshot.snapshotId);
                        }}
                    >
                        {_("Restore")}
                    </a>
                    <a
                        href="#"
                        className="text-danger text-decoration-none"
                        onClick={(e) => {
                            e.preventDefault();
                            setShowDeleteConform(true);
                            setSelectedSnapshotId(snapshot.snapshotId);
                        }}
                    >
                        {_("Delete")}
                    </a>
                </div>
            );
        }
    };

    const language = cockpit.language; // 获取cockpit的当前语言环境

    return (
        <>
            {/* 页面标题行 */}
            <Row className="align-items-center mb-4">
                <Col xs={12} md={8}>
                    <h4 className="mb-0">{_("Backup List")}</h4>
                </Col>
                <Col xs={12} md={4}>
                    <div className="d-flex gap-2 float-end">
                        <Button
                            variant="outline-secondary"
                            onClick={getSnapshots}
                            disabled={loading}
                        >
                            {loading ? _("Refreshing...") : _("Refresh")}
                        </Button>
                        <Button
                            variant="primary"
                            onClick={() => setShowCreateBackup(true)}
                        >
                            {_("Create Backup")}
                        </Button>
                    </div>
                </Col>
            </Row>

            {/* 备份列表表格 */}
            <Row>
                <Col xs={12}>
                    <Card>
                        <Card.Body>
                            <Table className="mb-0">
                                <thead>
                                    <tr>
                                        <th style={{ width: '20%' }}>{_("ID")}</th>
                                        <th style={{ width: '25%' }}>{_("Name")}</th>
                                        <th style={{ width: '10%' }}>{_("Type")}</th>
                                        <th style={{ width: '20%' }}>{_("Created At")}</th>
                                        <th style={{ width: '15%' }}>{_("Retention Period")}</th>
                                        <th style={{ width: '10%' }}>{_("Action")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {snapshots.length === 0 && !loading ? (
                                        <tr>
                                            <td colSpan="6" className="text-center py-4">
                                                <div className="text-muted">
                                                    {error ? error : _("No backup data available")}
                                                </div>
                                            </td>
                                        </tr>
                                    ) : (
                                        snapshots.map((snapshot) => (
                                            <tr key={snapshot.snapshotId}>
                                                <td style={{ verticalAlign: 'middle', whiteSpace: 'normal' }}>
                                                    {snapshot.snapshotId}
                                                </td>
                                                <td style={{ verticalAlign: 'middle', whiteSpace: 'normal' }}>
                                                    {snapshot.snapshotName || "-"}
                                                </td>
                                                <td style={{ verticalAlign: 'middle' }}>
                                                    <Badge
                                                        bg={snapshot.snapshotType === 'timer' ? 'success' : 'warning'}
                                                        text={snapshot.snapshotType === 'timer' ? 'white' : 'dark'}
                                                    >
                                                        {getSnapshotType(snapshot.snapshotType)}
                                                    </Badge>
                                                </td>
                                                <td style={{ verticalAlign: 'middle', fontSize: '1em' }}>
                                                    {language === "zh_CN" ? formatCreationTime(snapshot.creationTime) : new Date(snapshot.creationTime).toLocaleString('en-US', {
                                                        year: 'numeric',
                                                        month: '2-digit',
                                                        day: '2-digit',
                                                        hour: '2-digit',
                                                        minute: '2-digit',
                                                        second: '2-digit'
                                                    })}
                                                </td>
                                                <td style={{ verticalAlign: 'middle' }}>
                                                    {getRetentionPeriod(snapshot.retentionDays)}
                                                </td>
                                                <td style={{ verticalAlign: 'middle' }}>
                                                    {renderBackupStatus(snapshot)}
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </Table>
                            {loading && (
                                <div className="text-center mt-3">
                                    <Spinner animation="border" variant="secondary" />
                                </div>
                            )}
                        </Card.Body>
                    </Card>
                </Col>
            </Row>

            <DeleteConform
                show={showDeleteConform}
                onClose={() => setShowDeleteConform(false)}
                snapshotId={selectedSnapshotId}
                snapshot={snapshots.find(snap => snap.snapshotId === selectedSnapshotId)}
                onDeleteSuccess={getSnapshots}
            />
            <CreateBackupModal
                show={showCreateBackup}
                onClose={() => setShowCreateBackup(false)}
                onCreateSuccess={getSnapshots}
                snapshots={snapshots}
            />
            <RestoreConform
                show={showRestoreConform}
                onClose={() => setShowRestoreConform(false)}
                snapshotId={selectedSnapshotId}
                snapshot={snapshots.find(snap => snap.snapshotId === selectedSnapshotId)}
                onRestoreSuccess={getSnapshots}
            />
        </>
    );
};

export default BackUp;
