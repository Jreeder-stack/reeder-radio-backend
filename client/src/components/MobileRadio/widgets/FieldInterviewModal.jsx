import { useState, useEffect } from 'react';
import { X, Save, Loader2 } from 'lucide-react';
import { useAuth } from '../../../AuthContext';

const STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
const TRESPASS_TYPES = ['Business', 'Residential'];

const DEFAULT_CONFIG = {
  counties: [],
  sexOptions: ['Male', 'Female', 'Unknown'],
  raceOptions: ['White', 'Black', 'Hispanic', 'Asian', 'Native American', 'Pacific Islander', 'Other', 'Unknown'],
  eyeColors: ['Brown', 'Blue', 'Green', 'Hazel', 'Gray', 'Black', 'Unknown'],
  hairColors: ['Black', 'Brown', 'Blonde', 'Red', 'Gray', 'White', 'Bald', 'Unknown'],
  vehicleTypes: ['Sedan', 'SUV', 'Truck', 'Van', 'Motorcycle', 'Other'],
  vehicleStyles: ['2-Door', '4-Door', 'Hatchback', 'Convertible', 'Pickup', 'Other'],
  vehicleColors: ['Black', 'White', 'Silver', 'Gray', 'Red', 'Blue', 'Green', 'Brown', 'Tan', 'Gold', 'Orange', 'Yellow', 'Purple', 'Other']
};

const initialForm = {
  fiNumber: 'NEW',
  callNumber: '',
  otherNumber: '',
  date: '',
  time: '',
  officer: '',
  agency: '',
  location: '',
  xStreet: '',
  city: '',
  state: '',
  zip: '',
  county: '',
  reason: '',
  lastName: '',
  firstName: '',
  middleName: '',
  dob: '',
  sex: '',
  race: '',
  heightFt: '',
  heightIn: '',
  weight: '',
  eyes: '',
  hair: '',
  dlNumber: '',
  dlState: '',
  phone: '',
  workPhone: '',
  streetAddress: '',
  unit: '',
  personCity: '',
  personState: '',
  personZip: '',
  clothing: '',
  vehLicense: '',
  vehState: '',
  vehTag: '',
  vehYear: '',
  vehVin: '',
  vehType: '',
  vehMake: '',
  vehModel: '',
  vehStyle: '',
  vehColor: '',
  vehComment: '',
  wasTrespassed: false,
  trespassExpires: '',
  indefiniteTrespass: false,
  trespassType: '',
  businessName: '',
  trespassAddress: '',
  trespassCity: '',
  trespassState: '',
  trespassReason: '',
};

function SectionHeader({ title }) {
  return (
    <div className="bg-gray-100 border-y border-gray-300 px-3 py-2 -mx-4 mt-4 first:mt-0">
      <h3 className="text-xs font-bold text-gray-600 uppercase tracking-wider">{title}</h3>
    </div>
  );
}

function FieldLabel({ children }) {
  return <label className="text-xs text-gray-500 uppercase font-medium">{children}</label>;
}

function InputField({ label, value, onChange, type = 'text', placeholder = '', disabled = false }) {
  return (
    <div className="flex flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        className={`p-2 border border-gray-300 rounded text-black text-sm ${disabled ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-white'}`}
      />
    </div>
  );
}

function SelectField({ label, value, onChange, options, placeholder = 'Select...', disabled = false }) {
  return (
    <div className="flex flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      <select
        value={value}
        onChange={onChange}
        disabled={disabled}
        className={`p-2 border border-gray-300 rounded text-black text-sm ${disabled ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-white'}`}
      >
        <option value="">{placeholder}</option>
        {options.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </div>
  );
}

function TextAreaField({ label, value, onChange, placeholder = '', disabled = false }) {
  return (
    <div className="flex flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      <textarea
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        className={`p-2 border border-gray-300 rounded text-black text-sm h-20 resize-none ${disabled ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-white'}`}
      />
    </div>
  );
}

export function FieldInterviewModal({ show, onClose }) {
  const { user } = useAuth();
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [savedFiNumber, setSavedFiNumber] = useState(null);
  const [error, setError] = useState(null);
  const [config, setConfig] = useState(DEFAULT_CONFIG);

  useEffect(() => {
    if (show) {
      fetch('/api/cad/system/config', { credentials: 'include' })
        .then(res => res.json())
        .then(data => {
          setConfig({
            counties: data.counties || DEFAULT_CONFIG.counties,
            sexOptions: data.sexOptions || data.sex_options || DEFAULT_CONFIG.sexOptions,
            raceOptions: data.raceOptions || data.race_options || DEFAULT_CONFIG.raceOptions,
            eyeColors: data.eyeColors || data.eye_colors || DEFAULT_CONFIG.eyeColors,
            hairColors: data.hairColors || data.hair_colors || DEFAULT_CONFIG.hairColors,
            vehicleTypes: data.vehicleTypes || data.vehicle_types || DEFAULT_CONFIG.vehicleTypes,
            vehicleStyles: data.vehicleStyles || data.vehicle_styles || DEFAULT_CONFIG.vehicleStyles,
            vehicleColors: data.vehicleColors || data.vehicle_colors || DEFAULT_CONFIG.vehicleColors,
          });
        })
        .catch(() => {
          setConfig(DEFAULT_CONFIG);
        });

      fetch('/api/cad/unit/current-call', { credentials: 'include' })
        .then(res => res.json())
        .then(data => {
          if (data.callNumber) {
            setForm(p => ({ ...p, callNumber: data.callNumber }));
          }
        })
        .catch(() => {});

      const officer = user?.unit_id || user?.username || '';
      const agency = user?.agency || '';
      setForm(p => ({ ...p, officer, agency }));
    }
  }, [show, user]);

  const updateField = (field) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm(p => {
      const updated = { ...p, [field]: value };
      if (field === 'wasTrespassed' && !value) {
        updated.trespassExpires = '';
        updated.indefiniteTrespass = false;
        updated.trespassType = '';
        updated.businessName = '';
        updated.trespassAddress = '';
        updated.trespassCity = '';
        updated.trespassState = '';
        updated.trespassReason = '';
      }
      return updated;
    });
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/cad/fi/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (response.ok) {
        setSavedFiNumber(data.fiNumber || data.fi_number || null);
        setSuccess(true);
        setTimeout(() => {
          handleClose();
        }, 2000);
      } else {
        setError(data.message || 'Failed to save FI');
      }
    } catch (err) {
      setError('Failed to connect to CAD');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setForm(initialForm);
    setSuccess(false);
    setSavedFiNumber(null);
    setError(null);
    onClose();
  };

  if (!show) return null;

  const trespassDisabled = !form.wasTrespassed;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white w-full h-full md:rounded-xl md:max-w-lg md:max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-gray-300 flex items-center justify-between bg-cyan-600 md:rounded-t-xl">
          <h2 className="text-white font-bold text-lg">Field Interview</h2>
          <button onClick={handleClose} className="text-white">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {success ? (
            <div className="py-16 text-center">
              <p className="text-green-600 font-bold text-xl">FI Saved Successfully!</p>
              {savedFiNumber && (
                <p className="text-gray-700 mt-2">FI # <span className="font-bold">{savedFiNumber}</span></p>
              )}
            </div>
          ) : (
            <>
              <SectionHeader title="General Information" />
              <div className="space-y-3 mt-3">
                <div className="grid grid-cols-3 gap-2">
                  <div className="flex flex-col gap-1">
                    <FieldLabel>FI #</FieldLabel>
                    <div className="p-2 border border-gray-300 rounded text-gray-500 text-sm bg-gray-100">
                      {form.fiNumber}
                    </div>
                  </div>
                  <InputField label="Call #" value={form.callNumber} onChange={updateField('callNumber')} />
                  <InputField label="Other #" value={form.otherNumber} onChange={updateField('otherNumber')} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <InputField label="Date" value={form.date} onChange={updateField('date')} type="date" />
                  <InputField label="Time" value={form.time} onChange={updateField('time')} type="time" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <FieldLabel>Officer</FieldLabel>
                    <div className="p-2 border border-gray-300 rounded text-gray-700 text-sm bg-gray-100">
                      {form.officer || 'Not logged in'}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <FieldLabel>Agency</FieldLabel>
                    <div className="p-2 border border-gray-300 rounded text-gray-700 text-sm bg-gray-100">
                      {form.agency || 'N/A'}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <InputField label="Location" value={form.location} onChange={updateField('location')} />
                  <InputField label="X Street" value={form.xStreet} onChange={updateField('xStreet')} />
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <InputField label="City" value={form.city} onChange={updateField('city')} />
                  <SelectField label="State" value={form.state} onChange={updateField('state')} options={STATES} />
                  <InputField label="Zip" value={form.zip} onChange={updateField('zip')} />
                  {config.counties.length > 0 ? (
                    <SelectField label="County" value={form.county} onChange={updateField('county')} options={config.counties} />
                  ) : (
                    <InputField label="County" value={form.county} onChange={updateField('county')} />
                  )}
                </div>
                <TextAreaField label="Reason" value={form.reason} onChange={updateField('reason')} />
              </div>

              <SectionHeader title="Person Information" />
              <div className="space-y-3 mt-3">
                <div className="grid grid-cols-3 gap-2">
                  <InputField label="Last Name" value={form.lastName} onChange={updateField('lastName')} />
                  <InputField label="First Name" value={form.firstName} onChange={updateField('firstName')} />
                  <InputField label="Middle Name" value={form.middleName} onChange={updateField('middleName')} />
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <InputField label="D.O.B." value={form.dob} onChange={updateField('dob')} type="date" />
                  <SelectField label="Sex" value={form.sex} onChange={updateField('sex')} options={config.sexOptions} />
                  <SelectField label="Race" value={form.race} onChange={updateField('race')} options={config.raceOptions} />
                  <div className="flex flex-col gap-1">
                    <FieldLabel>Height</FieldLabel>
                    <div className="flex gap-1">
                      <input
                        type="number"
                        value={form.heightFt}
                        onChange={updateField('heightFt')}
                        placeholder="FT"
                        className="p-2 border border-gray-300 rounded text-black text-sm bg-white w-12"
                      />
                      <input
                        type="number"
                        value={form.heightIn}
                        onChange={updateField('heightIn')}
                        placeholder="IN"
                        className="p-2 border border-gray-300 rounded text-black text-sm bg-white w-12"
                      />
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <InputField label="Weight (lbs)" value={form.weight} onChange={updateField('weight')} type="number" />
                  <SelectField label="Eyes" value={form.eyes} onChange={updateField('eyes')} options={config.eyeColors} />
                  <SelectField label="Hair" value={form.hair} onChange={updateField('hair')} options={config.hairColors} />
                  <div />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <InputField label="DL #" value={form.dlNumber} onChange={updateField('dlNumber')} />
                  <SelectField label="DL State" value={form.dlState} onChange={updateField('dlState')} options={STATES} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <InputField label="Phone #" value={form.phone} onChange={updateField('phone')} type="tel" />
                  <InputField label="Work Phone #" value={form.workPhone} onChange={updateField('workPhone')} type="tel" />
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <div className="col-span-2">
                    <InputField label="Street Address" value={form.streetAddress} onChange={updateField('streetAddress')} />
                  </div>
                  <InputField label="Unit" value={form.unit} onChange={updateField('unit')} />
                  <InputField label="City" value={form.personCity} onChange={updateField('personCity')} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <SelectField label="State" value={form.personState} onChange={updateField('personState')} options={STATES} />
                  <InputField label="Zip" value={form.personZip} onChange={updateField('personZip')} />
                </div>
                <TextAreaField label="Clothing / Other Description" value={form.clothing} onChange={updateField('clothing')} />
              </div>

              <SectionHeader title="Vehicle Information" />
              <div className="space-y-3 mt-3">
                <div className="grid grid-cols-4 gap-2">
                  <InputField label="License" value={form.vehLicense} onChange={updateField('vehLicense')} />
                  <SelectField label="State" value={form.vehState} onChange={updateField('vehState')} options={STATES} />
                  <InputField label="Tag" value={form.vehTag} onChange={updateField('vehTag')} />
                  <InputField label="Year" value={form.vehYear} onChange={updateField('vehYear')} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <InputField label="VIN #" value={form.vehVin} onChange={updateField('vehVin')} />
                  <SelectField label="Type" value={form.vehType} onChange={updateField('vehType')} options={config.vehicleTypes} />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <InputField label="Make" value={form.vehMake} onChange={updateField('vehMake')} />
                  <InputField label="Model" value={form.vehModel} onChange={updateField('vehModel')} />
                  <SelectField label="Style" value={form.vehStyle} onChange={updateField('vehStyle')} options={config.vehicleStyles} />
                </div>
                <SelectField label="Color" value={form.vehColor} onChange={updateField('vehColor')} options={config.vehicleColors} />
                <TextAreaField label="Comment" value={form.vehComment} onChange={updateField('vehComment')} />
              </div>

              <SectionHeader title="Trespass Information" />
              <div className="space-y-3 mt-3">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.wasTrespassed}
                    onChange={updateField('wasTrespassed')}
                    className="w-5 h-5"
                  />
                  <span className="text-sm text-black font-medium">Was the person trespassed?</span>
                </label>
                
                <div className="grid grid-cols-2 gap-2">
                  <InputField 
                    label="Trespass Expires Date" 
                    value={form.trespassExpires} 
                    onChange={updateField('trespassExpires')} 
                    type="date"
                    disabled={trespassDisabled}
                  />
                  <div className="flex items-end pb-2">
                    <label className={`flex items-center gap-2 ${trespassDisabled ? 'opacity-50' : ''}`}>
                      <input
                        type="checkbox"
                        checked={form.indefiniteTrespass}
                        onChange={updateField('indefiniteTrespass')}
                        className="w-5 h-5"
                        disabled={trespassDisabled}
                      />
                      <span className="text-sm text-black font-medium">Indefinite Trespass</span>
                    </label>
                  </div>
                </div>

                <SelectField 
                  label="Trespassed From (Business or Residential)" 
                  value={form.trespassType} 
                  onChange={updateField('trespassType')} 
                  options={TRESPASS_TYPES}
                  disabled={trespassDisabled}
                />

                {form.trespassType === 'Business' && !trespassDisabled && (
                  <InputField 
                    label="Business Name" 
                    value={form.businessName} 
                    onChange={updateField('businessName')}
                    disabled={trespassDisabled}
                  />
                )}

                <InputField 
                  label="Address" 
                  value={form.trespassAddress} 
                  onChange={updateField('trespassAddress')}
                  disabled={trespassDisabled}
                />
                <div className="grid grid-cols-2 gap-2">
                  <InputField 
                    label="City" 
                    value={form.trespassCity} 
                    onChange={updateField('trespassCity')}
                    disabled={trespassDisabled}
                  />
                  <SelectField 
                    label="State" 
                    value={form.trespassState} 
                    onChange={updateField('trespassState')} 
                    options={STATES}
                    disabled={trespassDisabled}
                  />
                </div>
                <TextAreaField 
                  label="Reason for Trespass" 
                  value={form.trespassReason} 
                  onChange={updateField('trespassReason')}
                  disabled={trespassDisabled}
                />
              </div>

              {error && <p className="text-red-600 text-sm mt-4">{error}</p>}
            </>
          )}
        </div>

        {!success && (
          <div className="p-4 border-t border-gray-300 flex gap-2">
            <button
              onClick={handleClose}
              className="flex-1 py-3 bg-gray-200 text-black font-bold uppercase rounded"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={loading}
              className="flex-1 py-3 bg-cyan-600 text-white font-bold uppercase rounded flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
